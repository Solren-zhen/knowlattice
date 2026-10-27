"""从归档里的四个安装包重建解包目录（content-packs/tools/build_packs.py --src 认的布局）。

素材原件放在**仓库外**：C:\Users\甄朝晖\Desktop\晶格个人资料
  01-原始安装包/   四个 APK（只读，不改）
  02-解包副本/     本脚本的默认输出（build_packs.py 直接拿这个当 --src）
  03-影像图集/     4 手写笔记/  —— 只作资料，不进软件

只抽 content-packs 需要的那几段，不解整包（省掉 res/、META-INF/、dex 之外的噪音）：
  02-解包副本/wcwww/data/**                    万川医考 assets/www/**
  02-解包副本/db/assets/pack/**                窦起心搏 assets/pack/**
  02-解包副本/st/assets/initial_libraries.json 刷题宝  assets/initial_libraries.json
  02-解包副本/yb/lib/**                        医不帮  lib/**（无内置题库，只留 native）

用法：python med-archive/tools/unpack.py [输出目录]
      默认输出到 02-解包副本/；可用环境变量 JINGGE_DATA 改归档根路径。
"""
import os
import shutil
import sys
import zipfile

ARCHIVE = os.environ.get("JINGGE_DATA") or os.path.join(
    os.path.expanduser("~"), "Desktop", "晶格个人资料"
)
APK = os.path.join(ARCHIVE, "01-原始安装包")

# (apk 文件名, 归档内前缀, 落到 unpacked 下的相对目录, 是否只取单个文件)
JOBS = [
    ("万川医考_v1.22.apk", "assets/www/", "wcwww", False),
    ("窦起心搏_离线版_v2.48.apk", "assets/pack/", os.path.join("db", "assets", "pack"), False),
    ("刷题宝.apk", "assets/initial_libraries.json", os.path.join("st", "assets"), True),
    ("医不帮_2.0.2.apk", "lib/", os.path.join("yb", "lib"), False),
]


def extract(apk_path, prefix, out_dir, single):
    n = 0
    total = 0
    with zipfile.ZipFile(apk_path) as z:
        for info in z.infolist():
            if info.is_dir() or not info.filename.startswith(prefix):
                continue
            rel = os.path.basename(info.filename) if single else info.filename[len(prefix):]
            if not rel:
                continue
            dest = os.path.join(out_dir, *rel.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            n += 1
            total += info.file_size
    return n, total


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ARCHIVE, "02-解包副本")
    if not os.path.isabs(out):
        out = os.path.join(ARCHIVE, out)
    for apk, prefix, dest, single in JOBS:
        path = os.path.join(APK, apk)
        if not os.path.isfile(path):
            sys.exit("缺文件：%s" % path)
        target = os.path.join(out, dest)
        shutil.rmtree(target, ignore_errors=True)
        n, size = extract(path, prefix, target, single)
        if n == 0:
            sys.exit("没抽到内容：%s 里的 %s" % (apk, prefix))
        print("  %-28s -> %-24s %5d 个文件 %8.1f MB" % (apk, dest, n, size / 1048576))


if __name__ == "__main__":
    main()
