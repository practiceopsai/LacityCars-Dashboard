import argparse
import json
import tempfile
import unittest
from pathlib import Path

import batch_posting_manifest as target


VIN1 = "4JGFB4KBXLA013794"
VIN2 = "W1KAF4GB9PR095851"


class PostingManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.request = self.write("request.json", {
            "request_id": "batch:8",
            "store": {"code": "COLUMBIA_CITY"},
            "vehicles": [
                {"request_id": "batch:8:1:a", "vin": VIN1, "freight": {"amount": 500, "evidence": {"loadId": "1", "loadPrice": 1000, "distinctVinCount": 2, "matchedRowNumbers": [4]}}},
                {"request_id": "batch:8:2:b", "vin": VIN2, "freight": {"amount": 500, "evidence": {"loadId": "1", "loadPrice": 1000, "distinctVinCount": 2, "matchedRowNumbers": [5]}}},
            ],
        })
        fields1 = {"Vehicle Description": "2020 MERCEDES-BENZ GLE 350 4MATIC", "Odometer": 73218, "Principal + One Day Loan": 21150, "Source": "South Florida Auto Auction of Ft. Lauderdale, LLC"}
        fields2 = {"Vehicle Description": "2023 MERCEDES-BENZ C 300 SEDAN", "Odometer": 48457, "Principal + One Day Loan": 24815, "Source": "South Florida Auto Auction of Ft. Lauderdale, LLC"}
        self.evidence = self.write("evidence.json", {"ready": True, "nextgear": {"vehicles": {VIN1: {"matches": [{"fields": fields1}]}, VIN2: {"matches": [{"fields": fields2}]}}}})
        self.validation = self.write("validation.json", {"ready": True, "sheet": {"path": "sheet.xlsx", "plan_mode": "REUSE_EXISTING_AND_APPEND", "candidates": [
            {"vin": VIN1, "stock": "S2429", "row": 2430, "sheet_action": "REUSE_EXISTING", "row_values_before": [None, "S2429", None, VIN1, 2020, "MERCEDES-BENZ", "GLE 350 4MATIC", "SILVER", 73218, None, 21150]},
            {"vin": VIN2, "stock": "S2431", "row": 2432, "sheet_action": "APPEND_NEW", "row_values_before": [None] * 11},
        ]}})
        self.decode = self.write("decode.json", {"ready": True, "vehicles": [
            {"VIN": VIN1, "ModelYear": "2020", "Make": "MERCEDES-BENZ", "Model": "GLE-Class", "BodyClass": "Sport Utility Vehicle", "VehicleType": "MULTIPURPOSE PASSENGER VEHICLE (MPV)"},
            {"VIN": VIN2, "ModelYear": "2023", "Make": "MERCEDES-BENZ", "Model": "C-Class", "BodyClass": "Sedan/Saloon", "VehicleType": "PASSENGER CAR"},
        ]})
        self.registry = self.root / "store.yaml"
        self.registry.write_text("""display_name: Columbia City
stock_sheet:
  stock_pattern: 'S####'
autosoft:
  host: colu64.autosoftflex.com:7069
  instance_title: Columbia City Cars LLC
  used_car_line: 9C
  used_truck_line: 9T
  used_car_inventory_gl: 24000
  used_truck_inventory_gl: 24100
  floorplan_gl: 31100
  transport_gl: 31105
internals:
  pack: {amount: 1761, credit_gl: 33115}
  lojack: {amount: 134, credit_gl: 33126}
  csc3mpro: {amount: 55, credit_gl: 33127}
  cilajet: {amount: 54, credit_gl: 33128}
  total: 2004
""", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def args(self, colors=None):
        return argparse.Namespace(request=self.request, evidence=self.evidence, validation=self.validation, decode=self.decode, store_registry=self.registry, output=self.root / "posting.json", color=colors or [])

    def test_builds_mixed_manifest_and_only_new_row_blocks(self):
        result = target.build(self.args([f"{VIN2}=BLACK"]))
        self.assertEqual([item["stock_number"] for item in result["vehicles"]], ["S2429", "S2431"])
        self.assertEqual(result["vehicles"][0]["expected_total"], 23654)
        self.assertEqual(result["vehicles"][1]["line"], "9C")
        self.assertEqual(result["vehicles"][1]["inventory_gl"], 24000)
        self.assertEqual(len(result["sheet"]["blocks"]), 3)
        self.assertTrue(all(block["row_start"] == 2432 for block in result["sheet"]["blocks"]))
        self.assertEqual((self.root / "posting-sheet-D-I-2432-2432.tsv").read_text(encoding="utf-8"), f"{VIN2}\t2023\tMERCEDES-BENZ\tC 300 SEDAN\tBLACK\t48457\n")

    def test_missing_new_vehicle_color_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "verified color is required"):
            target.build(self.args())

    def test_uses_la_sheet_layout_without_shifting_mileage_into_color(self):
        validation = json.loads(self.validation.read_text(encoding="utf-8"))
        validation["sheet"]["candidates"][0].update({
            "stock": "L12870",
            "row_values_before": [
                None,
                "L12870",
                None,
                VIN1,
                2020,
                "MERCEDES-BENZ",
                "GLE 350 4MATIC",
                73218,
                21150,
                "S FL AUTO AUCTION",
            ],
        })
        validation["sheet"]["candidates"][1]["stock"] = "L12930"
        self.validation.write_text(json.dumps(validation), encoding="utf-8")
        self.registry.write_text("""display_name: LA City
stock_sheet:
  columns:
    stock: B
    vin: D
    year: E
    make: F
    model: G
    mileage: H
    acv: I
  color_column: null
  stock_pattern: 'L#####'
autosoft:
  host: laci81.autosoftflex.com:7069
  instance_title: LA City Cars
  used_car_line: 9C
  used_truck_line: 9T
  used_car_inventory_gl: 24000
  used_truck_inventory_gl: 24100
  floorplan_gl: 31100
  transport_gl: 31105
internals:
  pack: {amount: 1761, credit_gl: 33115}
  lojack: {amount: 134, credit_gl: 33126}
  csc3mpro: {amount: 55, credit_gl: 33127}
  cilajet: {amount: 54, credit_gl: 33128}
  total: 2004
""", encoding="utf-8")

        result = target.build(self.args([f"{VIN1}=SILVER", f"{VIN2}=BLACK"]))

        self.assertEqual(result["vehicles"][0]["color"], "SILVER")
        self.assertEqual([item["columns"] for item in result["sheet"]["blocks"]], ["B", "D:I"])
        self.assertEqual(
            (self.root / "posting-sheet-D-I-2432-2432.tsv").read_text(encoding="utf-8"),
            f"{VIN2}\t2023\tMERCEDES-BENZ\tC 300 SEDAN\t48457\t24815.0\n",
        )


if __name__ == "__main__":
    unittest.main()
