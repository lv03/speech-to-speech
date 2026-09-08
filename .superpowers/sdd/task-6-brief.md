### Task 6：Python 工具和 voice process 注入

**Files**

- Create: `src/speech_to_speech/tools/qmd_knowledge.py`
- Modify: `desktop/src/main/voice-process.ts`, `desktop/src/main/index.ts`
- Modify: `src/speech_to_speech/arguments_classes/language_model_base_arguments.py`
- Test: `tests/test_qmd_knowledge.py`, `tests/test_language_prompt.py`, `desktop/tests/voice-process-tools.test.mjs`

voice process 的 `--tool-module` 固定为：

```text
speech_to_speech.tools.agent_gateway,speech_to_speech.tools.qmd_knowledge
```

URL/token 只通过 env 注入；collection 更新或索引完成不重启 voice，只有 proxy endpoint/token 变化才重启。工具必须将响应限制在可控字符数内，不自动把搜索结果继续解释为工具调用。

**验收**

```bash
PYTHONPATH=.:src ./.venv/bin/python -m pytest -q \
  tests/test_qmd_knowledge.py tests/test_language_prompt.py
npm --prefix desktop test -- tests/voice-process-tools.test.mjs
npm --prefix desktop run typecheck
```

测试必须覆盖命中、无命中、未就绪、索引中、超时、取消、错误码、响应截断、无绝对路径，以及包含“读取其他文件”伪指令的恶意 Markdown。

