"""PyInstaller 入口桩：以包成员身份进 openterminal.app.main。

直接把 src/openterminal/app.py 当脚本分析会丢包上下文（app.py 全是
相对 import，脚本模式下抛 ImportError），故经绝对导入进主入口。
"""

from openterminal.app import main

if __name__ == "__main__":
    main()
