#!/usr/bin/env bash
# Run with bash. Installs this project's dependencies into its own venv only.
set -euo pipefail

rice_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rice_venv_dir="${RICE_VENV_DIR:-$rice_project_dir/.venv}"
rice_pip_source="${RICE_PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
rice_python_bin="${RICE_PYTHON:-}"

rice_supported_python() {
    "$1" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' >/dev/null 2>&1
}

if [[ -x "$rice_venv_dir/bin/python" ]]; then
    if ! rice_supported_python "$rice_venv_dir/bin/python"; then
        echo 'Existing venv needs Python 3.10–3.13 (3.12 recommended). It was not overwritten.' >&2
        exit 1
    fi
else
    if [[ -n "$rice_python_bin" ]]; then
        if ! command -v "$rice_python_bin" >/dev/null 2>&1 || ! rice_supported_python "$rice_python_bin"; then
            echo 'RICE_PYTHON must point to Python 3.10–3.13 (3.12 recommended).' >&2
            exit 1
        fi
    else
        for rice_candidate in python3.12 python3.11 python3.13 python3.10 python3; do
            if command -v "$rice_candidate" >/dev/null 2>&1 && rice_supported_python "$rice_candidate"; then
                rice_python_bin="$(command -v "$rice_candidate")"
                break
            fi
        done
    fi
    if [[ -z "$rice_python_bin" ]]; then
        echo 'No suitable Python found. Use Python 3.10–3.13, or install a separate Python 3.12 project runtime in Baota.' >&2
        echo 'Then run: RICE_PYTHON=/path/to/python3 bash deploy/install-native.sh' >&2
        exit 1
    fi
    "$rice_python_bin" -m venv "$rice_venv_dir"
fi

# Refuse a base interpreter even if a misconfigured directory contains a symlink.
"$rice_venv_dir/bin/python" -c 'import sys; assert sys.prefix != sys.base_prefix, "Not a virtual environment"'
if ! "$rice_venv_dir/bin/python" -m pip --version >/dev/null 2>&1; then
    "$rice_venv_dir/bin/python" -m ensurepip --upgrade
fi
"$rice_venv_dir/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
    --index-url "$rice_pip_source" -r "$rice_project_dir/requirements.txt"

cd "$rice_project_dir"
"$rice_venv_dir/bin/python" -c 'from backend.app import app; print("Application import OK")'
printf 'Ready. Venv: %s\n' "$rice_venv_dir"
printf 'Test command: %s -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log\n' "$rice_venv_dir/bin/python"
