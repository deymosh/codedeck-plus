"""Unpack a .zip into a directory without the `unzip` binary.

A fallback for hosts that have python3 but no `unzip` and no way to install
it — the bridge's own runtime image is one. The caller
(scripts/install-toolchain.sh) uses `unzip` when it is there, and this when it
is not.

    python3 extract-zip.py <archive> <directory>

`zipfile.extractall` writes the bytes but not the Unix mode, so an archive
carrying an executable — the Android SDK's `sdkmanager` is one — would unpack
non-executable, and running it fails with "Permission denied": a message that
reads like a broken download rather than a lost file mode. Each entry's own
mode (`external_attr`'s high half) is applied afterwards.
"""

import os
import sys
import zipfile

archive, dest = sys.argv[1], sys.argv[2]

with zipfile.ZipFile(archive) as z:
    z.extractall(dest)
    for info in z.infolist():
        mode = info.external_attr >> 16
        if mode:
            os.chmod(os.path.join(dest, info.filename), mode & 0o777)
