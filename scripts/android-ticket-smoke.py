#!/usr/bin/env python3
"""Exercise Architect's Ticket entry in the native Android fork, from an open chat.

Requires uiautomator2 and ADB. Never sends a prompt or starts an Architect.
"""
import argparse
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', default='emulator-5580')
parser.add_argument('--adb-port', type=int, default=5039)
parser.add_argument('--artifacts', type=Path, required=True)
parser.add_argument('--expect', choices=['absent', 'present'], required=True)
parser.add_argument('--workspace-id', required=True, help='Exact workspace whose ticket must open')
parser.add_argument('--pure-black', action='store_true')
parser.add_argument('--conversation', help='Existing tab title to select before the test')
args = parser.parse_args()
os.environ['ANDROID_ADB_SERVER_PORT'] = str(args.adb_port)
import uiautomator2 as ui

d = ui.connect(args.serial)
d.settings['wait_timeout'] = 10
# A streaming conversation never becomes idle. Query the current native tree.
d.jsonrpc.setConfigurator({'waitForIdleTimeout': 0, 'waitForSelectorTimeout': 0})
args.artifacts.mkdir(parents=True, exist_ok=True)
(args.artifacts / 'result.json').unlink(missing_ok=True)


def capture(name):
    xml = d.dump_hierarchy()
    (args.artifacts / f'{name}.xml').write_text(xml)
    d.screenshot(str(args.artifacts / f'{name}.png'))
    return ET.fromstring(xml)


def wait_click(selector):
    assert selector.wait(timeout=10), f'Missing native control: {selector.selector}'
    selector.click()


try:
    assert d.app_current()['package'] == 'ai.hypermemetic.paseo', 'Open the fork app first'
    assert d(resourceId='workspace-tab-switcher-trigger').exists, 'Open a conversation first'
    if args.conversation:
        wait_click(d(resourceId='workspace-tab-switcher-trigger'))
        wait_click(d(description=args.conversation))
    assert d(description='Message agent...').wait(timeout=10), 'Expected the native conversation composer'
    tree = capture('conversation')
    switcher = next(n for n in tree.iter('node') if n.get('resource-id') == 'workspace-tab-switcher-trigger')
    conversation = next(n.get('text') for n in switcher.iter('node') if n.get('text'))
    ticket = d(description='Open Architect ticket')
    if args.expect == 'absent':
        assert not ticket.exists, 'Ticket button unexpectedly present in baseline'
        wait_click(d(resourceId='workspace-tab-switcher-trigger'))
        assert d(text='Switch tab').wait(timeout=5)
        capture('tab-switcher')
        assert not d(text='Ticket').exists, 'Ticket already exists in the native switcher'
        # Android Back can leave the activity; select the existing chat instead.
        wait_click(d(description=conversation))
        wait_click(d(resourceId='workspace-explorer-toggle'))
        assert d(resourceId='explorer-close').wait(timeout=5)
        capture('explorer')
        assert not d(text='Ticket').exists, 'Ticket unexpectedly available in compact Explorer'
        wait_click(d(resourceId='explorer-close'))
    else:
        wait_click(ticket)
        assert d(text='Ticket').wait(timeout=10), 'Ticket panel did not open'
        assert d(resourceId='architect-ticket-' + args.workspace_id).wait(timeout=10), 'Ticket opened the wrong workspace'
        assert d(resourceId='architect-ticket-plan').wait(timeout=10), 'Formatted plan did not load'
        assert not d(textContains='Couldn’t refresh').exists, 'Ticket refresh failed'
        capture('ticket-plan')
        wait_click(d(description='Show delegated work'))
        assert d(resourceId='architect-work-list').wait(timeout=10), 'Delegated work section did not render'
        assert not d(textContains='Plugin error').exists, 'Plugin failed to render'
        capture('ticket')
        if args.pure_black:
            shot = d.screenshot()
            assert shot.getpixel((8, shot.height // 2))[:3] == (0, 0, 0), 'Panel background is not Pure black'
        wait_click(d(description='Back to conversation'))
        assert d(description='Message agent...').wait(timeout=10), 'Could not return to chat'
        assert d(description='Open Architect ticket').exists, 'Ticket entry disappeared after return'
        capture('returned-to-conversation')
    (args.artifacts / 'result.json').write_text(json.dumps({'status': 'passed', 'expect': args.expect,
        'package': d.app_current()['package'], 'serial': args.serial, 'workspaceId': args.workspace_id, 'pureBlack': args.pure_black}, indent=2) + '\n')
    for suffix in ['xml', 'png']:
        (args.artifacts / f'failure.{suffix}').unlink(missing_ok=True)
    print(f'Native Android Ticket {args.expect}: passed')
except Exception:
    capture('failure')
    raise
finally:
    # The driver's default atexit cleanup does not wait and can kill the next run.
    d.stop_uiautomator(wait=True)
