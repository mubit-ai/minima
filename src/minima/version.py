# Derived from the installed package metadata so it can never drift from
# [project].version in pyproject.toml. This is what /v1/health and the FastAPI
# app report at runtime.
from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("minima-cli")
except PackageNotFoundError:  # editable/source checkout without install
    __version__ = "0.0.0+dev"
