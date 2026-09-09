"""Vector-store backends for mem0, imported only inside the sidecar.

Nothing here is imported by the voice process: these modules require mem0 (and,
for sqlite-vec, the ``sqlite-vec`` extension), which live in the sidecar venv.
"""
