---
name: python-testing
description: Writing correct Python unit tests with unittest and running them. Use when writing or running Python tests (unittest/pytest), assertions, or checking test coverage.
---

# Python testing

- Use the standard library **unittest**. Do NOT use pytest and do NOT `pip install` anything.
- Every test file MUST start with `import unittest` and then `import <module_under_test>`.
- Put the test file and the module at the **project root**; import the module by its plain name (`import calc`, then `calc.evaluate(...)`). Never invent a package folder like `calc/tests/`.
- One small test method per behaviour. Use explicit, hand-verifiable values — no loops or comprehensions inside asserts. Trace each expected value by hand before asserting it.
- Test the happy path AND each error case: `with self.assertRaises(ValueError): ...`.
- End the file with `if __name__ == "__main__": unittest.main()`.
- Run with exactly `python -m unittest` (or `python -m unittest discover`). Keep re-running the SAME command until it reports `OK`.
- If a test fails, the bug is almost always in the **implementation**, not the test — fix the implementation.
