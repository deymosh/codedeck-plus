"""Unpack a .tar.xz into a directory, one level down, without the `xz` binary.

A fallback for hosts that have python3 but no `xz`/`unxz` and no way to
install them — confirmed on a real sandbox with curl/tar/python3 and no root.
The caller (scripts/install-toolchain.sh) uses `tar -xJf` when xz is there,
and this when it is not.

    python3 extract-tar-xz.py <archive> <directory>

Emulates the `tar --strip-components=1` the caller would otherwise pass: the
archives are release tarballs that wrap everything in one top-level directory
(`node-v22.11.0-linux-x64/…`, `zig-linux-x86_64-0.14.1/…`), and the callers
want the contents directly in <directory>.
"""

import lzma
import sys
import tarfile

archive, dest = sys.argv[1], sys.argv[2]

with lzma.open(archive) as stream, tarfile.open(fileobj=stream) as tar:
    members = []
    for member in tar.getmembers():
        _, _, rest = member.name.partition("/")
        if not rest:
            # The top-level directory entry itself; its contents follow.
            continue
        member.name = rest
        members.append(member)
    tar.extractall(dest, members=members)
