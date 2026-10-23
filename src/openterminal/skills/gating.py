"""技能启用开关的 agent 侧落点。

SkillsMiddleware 没有 allowlist / exclude 参数（已核对 deepagents 源码），
它把扫到的清单装进 state，再由 `modify_request` 每轮取出来格式化进系统
提示词。所以拦截点选在 `_format_skills_list`：

- **关掉的 skill 不进提示词清单** → 模型根本不知道它存在，自然不会
  read_file 去加载全文，正是「不启动就不加载」的语义；
- **每轮请求都重新过滤**（不是在 before_agent 里过滤 state）→ 设置里改了
  开关下一轮立刻生效。若过滤写在 before_agent，清单会被 thread 缓存住，
  只有重建 agent 才刷新，而重建会新建 MemorySaver，等于清空该 tab 的对话。
"""

from __future__ import annotations

from deepagents.middleware.skills import SkillsMiddleware

from .store import disabled_names


class GatedSkillsMiddleware(SkillsMiddleware):
    """SkillsMiddleware + 启用开关：停用的 skill 不出现在模型可见的清单里。"""

    def _format_skills_list(self, skills):
        enabled = [s for s in skills if s["name"] not in disabled_names()]
        if skills and not enabled:
            # 全被关掉时别沿用基类的「(No skills available yet… 你可以创建)」
            # ——那会诱导模型去新建 skill
            return "(All skills are currently disabled by the user.)"
        return super()._format_skills_list(enabled)
