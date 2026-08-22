from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import patch

import batch_vpic_decode


class Response(BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def test_decode_vin_returns_only_stable_fields() -> None:
    body = {
        "Results": [
            {
                "VIN": "4JGFB4KBXLA013794",
                "ModelYear": "2020",
                "Make": "MERCEDES-BENZ",
                "Model": "GLE-Class",
                "BodyClass": "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)",
                "EngineCylinders": "4",
                "ErrorCode": "0",
                "ErrorText": "0 - VIN decoded clean.",
                "Unrelated": "not copied",
            }
        ]
    }
    with patch.object(batch_vpic_decode, "urlopen", return_value=Response(json.dumps(body).encode())):
        result = batch_vpic_decode.decode_vin("4JGFB4KBXLA013794")

    assert result["valid"] is True
    assert result["EngineCylinders"] == "4"
    assert "Unrelated" not in result


def test_normalize_vin_removes_spaces_and_rejects_forbidden_letters() -> None:
    assert batch_vpic_decode.normalize_vin(" 4jgfb4kbxla013794 ") == "4JGFB4KBXLA013794"
    assert not batch_vpic_decode.VIN_RE.fullmatch("4JGFB4KBILA013794")
