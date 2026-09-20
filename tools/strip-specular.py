#!/usr/bin/env python3
"""去掉 GLB 里的 KHR_materials_specular 扩展。

为什么：three.js 的 GLTFLoader 见到这个扩展会给材质建 MeshPhysicalMaterial
（three 里最贵的着色器，多了 specular/sheen/clearcoat 等一堆分支）。水墨鱼这种
平面感很强的贴图用不上它，去掉之后自动回落到 MeshStandardMaterial，
观感几乎不变，片元着色器开销明显下降。

用法: python3 tools/strip-specular.py <model.glb> [...]
"""
import json
import struct
import sys


def strip(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, version, _ = struct.unpack('<4sII', data[:12])
    assert magic == b'glTF', '不是 GLB 文件: ' + path
    off, js, bin_chunk = 12, None, b''
    while off < len(data):
        clen, ctype = struct.unpack('<I4s', data[off:off+8])
        chunk = data[off+8:off+8+clen]
        if ctype == b'JSON':
            js = json.loads(chunk)
        elif ctype.startswith(b'BIN'):
            bin_chunk = chunk
        off += 8 + clen

    removed = 0
    for mat in js.get('materials', []):
        if 'KHR_materials_specular' in mat.get('extensions', {}):
            del mat['extensions']['KHR_materials_specular']
            removed += 1
            if not mat['extensions']:
                del mat['extensions']
    used = js.get('extensionsUsed', [])
    if 'KHR_materials_specular' in used:
        used.remove('KHR_materials_specular')
    if used:
        js['extensionsUsed'] = used
    elif 'extensionsUsed' in js:
        del js['extensionsUsed']

    js_bytes = json.dumps(js, separators=(',', ':')).encode('utf-8')
    js_bytes += b' ' * ((4 - len(js_bytes) % 4) % 4)
    bin_bytes = bin_chunk + b'\x00' * ((4 - len(bin_chunk) % 4) % 4)
    total = 12 + 8 + len(js_bytes) + (8 + len(bin_bytes) if bin_bytes else 0)
    out = struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<I4s', len(js_bytes), b'JSON') + js_bytes
    if bin_bytes:
        out += struct.pack('<I4s', len(bin_bytes), b'BIN\x00') + bin_bytes
    with open(path, 'wb') as f:
        f.write(out)
    print('%s：去掉 %d 个材质上的 specular 扩展，%d → %d 字节' % (
        path.split('/')[-1], removed, len(data), len(out)))


if __name__ == '__main__':
    for p in sys.argv[1:]:
        strip(p)
