"""Bundle dependency declarations and available license/notice texts for binaries."""
import json
from pathlib import Path
import subprocess
import sys

metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--format-version=1"]))
seen = set()
with Path(sys.argv[1]).open("w") as out:
    out.write("Raydio dependency notices (includes build/test dependencies).\n")
    for package in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"], p["id"])):
        out.write(f'\n{package["name"]} {package["version"]}\nLicense: {package["license"]}\nSource: {package["source"] or package.get("repository") or "Raydio"}\n')
        root = Path(package["manifest_path"]).parent
        # Workspace licenses can live above a crate; stop at its checkout root.
        roots = [root]
        current = root
        for _ in range(3):
            if (current / ".git").exists():
                break
            current = current.parent
            roots.append(current)
        candidates = []
        for directory in roots:
            for pattern in ("LICENSE*", "LICENCE*", "COPYING*", "NOTICE*"):
                candidates.extend(directory.glob(pattern))
        # Native codec sources carry additional notices under their crate trees.
        if package["name"] in ("opus-head-sys", "mantle-xaac"):
            native_roots = [root] if package["name"] == "opus-head-sys" else [root.parent.parent / "third_party"]
            for directory in native_roots:
                for pattern in ("**/COPYING", "**/LICENSE", "**/NOTICE"):
                    candidates.extend(directory.glob(pattern))
        for path in sorted(set(candidates)):
            if not path.is_file() or path.stat().st_size > 1_000_000:
                continue
            contents = path.read_text(errors="replace")
            if contents in seen:
                continue
            seen.add(contents)
            out.write(f"\n--- {path.name} ---\n{contents}\n")
