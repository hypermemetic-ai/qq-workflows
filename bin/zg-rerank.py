#!/usr/bin/env python3
"""
Two-Stage Code Retrieval: zvec-grep + Jina-Reranker-v3.5
Stage 1: zvec-grep hybrid lexical (BM25) + dense vector (Qwen3-0.6B) candidate recall.
Stage 2: jina-reranker-v3.5 listwise cross-attention reranking on GPU/CPU.
"""

import os
import sys

VENV_PY = os.path.expanduser("~/.local/venvs/zg-rerank/bin/python3")
if os.path.exists(VENV_PY) and sys.executable != VENV_PY:
    os.execv(VENV_PY, [VENV_PY] + sys.argv)

import argparse
import json
import re
import subprocess
import time
import torch
from transformers import AutoModel

MODEL_ID = "jinaai/jina-reranker-v3.5"
_models = {}
_last_device = None

def get_device_and_dtype():
    if torch.cuda.is_available():
        return "cuda", torch.bfloat16
    return "cpu", torch.bfloat16

def get_model(device=None):
    global _models
    if device is None:
        device, _ = get_device_and_dtype()
    if device not in _models:
        _, dtype = get_device_and_dtype()
        model = AutoModel.from_pretrained(
            MODEL_ID,
            trust_remote_code=True,
            local_files_only=True,
            dtype=dtype
        )
        model.to(device)
        model.eval()
        _models[device] = model
    return _models[device]

def drop_model(device):
    global _models
    if device in _models:
        del _models[device]
    if device == "cuda" and torch.cuda.is_available():
        torch.cuda.empty_cache()
    import gc
    gc.collect()

def query_zg(query, root, limit=20):
    """Run zg query with full preview to retrieve stage-1 candidates."""
    zg_bin = "/home/linuxbrew/.linuxbrew/bin/zg"
    cmd = [
        zg_bin,
        "query",
        query,
        "--limit", str(limit),
        "--preview", "full"
    ]
    env = os.environ.copy()
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        return []

    lines = proc.stdout.splitlines()
    candidates = []
    current = None

    header_re = re.compile(r"^#\d+\s+matchedBy=\S+\s+([^:]+):(\d+)(?:-(\d+))?")

    for line in lines:
        m = header_re.match(line)
        if m:
            if current and current["text"]:
                candidates.append(current)
            current = {
                "path": m.group(1),
                "start": int(m.group(2)),
                "end": int(m.group(3)) if m.group(3) else int(m.group(2)),
                "text": ""
            }
            continue

        if current is not None:
            if line.strip() == "source:":
                continue
            # Source lines typically start with "<line_num>\t"
            if re.match(r"^\d+\t", line):
                code_line = re.sub(r"^\d+\t", "", line)
                current["text"] += code_line + "\n"
            elif line.startswith("symbol:") or line.startswith("scope:") or line.startswith("heading:"):
                current["text"] += f"// {line}\n"

    if current and current["text"]:
        candidates.append(current)

    # Fallback: read file slice directly if preview was empty
    for c in candidates:
        if not c["text"].strip():
            full_path = os.path.join(root, c["path"])
            if os.path.exists(full_path):
                try:
                    with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                        file_lines = f.readlines()
                    start_idx = max(0, c["start"] - 1)
                    end_idx = min(len(file_lines), c["end"])
                    c["text"] = "".join(file_lines[start_idx:end_idx])
                except Exception:
                    pass

    return candidates

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

def rerank(query, candidates, top_n=5, batch_size=5):
    if not candidates:
        return [], 0.0

    docs = [f"File: {c['path']}:{c['start']}-{c['end']}\n{c['text']}" for c in candidates]

    start = time.perf_counter()
    try:
        scored = _rerank_batches(query, docs, candidates, batch_size)
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except torch.OutOfMemoryError:
        # 6GB card shared with transcription servers + zg embeddings: GPU
        # attempt failed, free everything and redo on CPU. Slow but completes.
        print("CUDA OOM during rerank; retrying on CPU.", flush=True)
        drop_model("cuda")
        scored = _rerank_batches(query, docs, candidates, batch_size, device="cpu")
        device = "cpu"
    elapsed_ms = (time.perf_counter() - start) * 1000

    scored.sort(key=lambda x: x["score"], reverse=True)
    global _last_device
    _last_device = device
    return scored[:top_n], elapsed_ms


def _rerank_batches(query, docs, candidates, batch_size, device=None):
    model = get_model(device)
    all_scored = []
    for i in range(0, len(docs), batch_size):
        batch = docs[i:i + batch_size]
        res = model.rerank(query, batch, top_n=len(batch))
        for r in res:
            idx = i + r["index"]
            item = dict(candidates[idx])
            item["score"] = float(r["relevance_score"])
            all_scored.append(item)
    return all_scored

def main():
    parser = argparse.ArgumentParser(description="Two-stage code search using zg + Jina-Reranker-v3.5")
    parser.add_argument("query", help="Natural language or code query")
    parser.add_argument("--root", default=os.getcwd(), help="Repository root directory")
    parser.add_argument("--candidates", type=int, default=20, help="Number of stage-1 candidates from zg")
    parser.add_argument("--top", type=int, default=5, help="Number of top reranked hits to return")
    parser.add_argument("--json", action="store_true", help="Output JSON")

    args = parser.parse_args()

    candidates = query_zg(args.query, args.root, limit=args.candidates)
    if not candidates:
        print(f"No candidates found by zg for query: {args.query}")
        return

    reranked, elapsed_ms = rerank(args.query, candidates, top_n=args.top)

    if args.json:
        print(json.dumps({"elapsed_ms": elapsed_ms, "query": args.query, "results": reranked}, indent=2))
        return

    device = _last_device or get_device_and_dtype()[0]
    print(f"\n⚡ Jina-Reranker-v3.5 ({device.upper()}) reranked {len(candidates)} candidates in {elapsed_ms:.1f} ms for:")
    print(f"   \"{args.query}\"\n")
    print("=" * 80)
    for rank, hit in enumerate(reranked, 1):
        print(f"#{rank} [Score: {hit['score']:+.4f}] {hit['path']}:{hit['start']}-{hit['end']}")
        preview_lines = hit["text"].strip().splitlines()
        preview = "\n  ".join(preview_lines[:6])
        print(f"  {preview}")
        if len(preview_lines) > 6:
            print(f"  ... (+{len(preview_lines)-6} more lines)")
        print("-" * 80)

if __name__ == "__main__":
    main()
