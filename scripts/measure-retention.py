"""Replay conversation retention using local Codex JSONL logs; emit counts only.

Run with runtimes/python/.venv/bin/python scripts/measure-retention.py LOG [LOG...].
The tokenizer is a counting proxy, not a claim about the provider's tokenizer.
"""
import argparse
import json
import statistics
from pathlib import Path

import tiktoken


def read_turns(path, count):
    turns = {}
    seen = set()
    for line in path.open():
        record = json.loads(line)
        event = record.get('payload', {})
        if record.get('type') != 'event_msg' or not event.get('turn_id'):
            continue
        turn = turns.setdefault(event['turn_id'], {'user': [], 'assistant': [], 'status': 'incomplete'})
        if event['type'] == 'item_completed':
            item = event.get('item', {})
            identity = (event['turn_id'], item.get('id'))
            if identity in seen:
                continue
            seen.add(identity)
            text = '\n'.join(block.get('text', '') for block in item.get('content', [])
                             if isinstance(block, dict) and block.get('type') in ('text', 'Text', 'input_text', 'output_text'))
            if text and item.get('type') in ('UserMessage', 'AgentMessage'):
                turn['user' if item['type'] == 'UserMessage' else 'assistant'].append(text)
        elif event['type'] == 'task_complete':
            turn['status'] = 'complete'
        elif event['type'] == 'turn_aborted':
            turn['status'] = 'aborted'
    result = [turn for turn in turns.values() if turn['user']]
    for turn in result:
        turn['tokens'] = count('\n'.join(turn['user'] + turn['assistant']))
        turn['userTokens'] = count('\n'.join(turn['user']))
    return result


def percentile(values, fraction):
    return sorted(values)[round((len(values) - 1) * fraction)] if values else None


def replay(conversations, floor):
    samples, exchanges = [], []
    losses = cases = 0
    for turns in conversations:
        history = []
        for turn in turns:
            if turn['status'] != 'complete':
                continue
            total, kept = turn['userTokens'], []
            for previous in reversed(history):
                if kept and total >= floor:
                    break
                total += previous['tokens']
                kept.append(previous)
            if len(history) >= 2:
                samples.append(total)
                exchanges.append(len(kept) + 1)
                # A mechanical proxy: a short exchange followed by a short prompt
                # should not immediately erase all preceding substantial exchanges.
                if history[-1]['tokens'] < 128 and turn['userTokens'] < 128 and any(p['tokens'] >= 512 for p in history[:-1]):
                    cases += 1
                    losses += not any(p['tokens'] >= 512 for p in kept)
            history.append(turn)
    return {
        'requests': len(samples),
        'medianConversationTokens': statistics.median(samples) if samples else None,
        'p90ConversationTokens': percentile(samples, .9),
        'medianExchanges': statistics.median(exchanges) if exchanges else None,
        'p90Exchanges': percentile(exchanges, .9),
        'shortTurnLosses': losses,
        'shortTurnCases': cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('logs', nargs='+', type=Path)
    args = parser.parse_args()
    encoding = tiktoken.get_encoding('o200k_base')
    count = lambda text: len(encoding.encode(text, disallowed_special=()))
    conversations = [read_turns(path, count) for path in args.logs]
    turns = [turn for conversation in conversations for turn in conversation]
    completed = [turn for turn in turns if turn['status'] == 'complete']
    print(json.dumps({
        'tokenizer': 'o200k_base (proxy)',
        'conversations': len(conversations),
        'turns': len(turns),
        'completed': len(completed),
        'aborted': sum(turn['status'] == 'aborted' for turn in turns),
        'incomplete': sum(turn['status'] == 'incomplete' for turn in turns),
        'completedUnder128': sum(turn['tokens'] < 128 for turn in completed),
        'policies': {floor: replay(conversations, floor) for floor in (0, 512, 1024, 2048, 4096)},
    }, indent=2))


if __name__ == '__main__':
    main()
