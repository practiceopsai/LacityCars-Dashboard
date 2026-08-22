import unittest

from focus_autosoft_rdp import title_aliases


class TitleAliasesTest(unittest.TestCase):
    def test_native_title_is_preserved(self) -> None:
        self.assertEqual(title_aliases("colu64.autosoftflex.com"), {"colu64.autosoftflex.com"})

    def test_columbia_inner_instance_maps_to_native_title(self) -> None:
        aliases = title_aliases("Columbia City Cars LLC")
        self.assertIn("colu64.autosoftflex.com", aliases)
        self.assertIn("autosoft columbia city", aliases)

    def test_la_inner_instance_maps_to_native_title(self) -> None:
        aliases = title_aliases("LA City Cars")
        self.assertIn("laci81.autosoftflex.com", aliases)
        self.assertIn("autosoft la city", aliases)

    def test_unknown_store_does_not_gain_a_broad_alias(self) -> None:
        self.assertEqual(title_aliases("Example Store LLC"), {"example store llc"})


if __name__ == "__main__":
    unittest.main()
