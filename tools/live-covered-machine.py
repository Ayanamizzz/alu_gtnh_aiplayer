#!/usr/bin/env python3
"""Real GT cover regression. Overwrites the small platform at (16,100,8) in THIS
checkout's disposable test world. RCON arranges fixtures, all interactions run as
a player. Example: --fixture-world World-fb4 --out /tmp/covered-machine.json
"""
import argparse
import json
from pathlib import Path
import time

from bridge import Bridge, ROOT, _local_env
from rcon import run

BOT = 'CoverQA'
AT = {'x': 16, 'y': 100, 'z': 8}
POS = '16 100 8'
FILTER = 32271  # GT filtered conveyor (import)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--fixture-world', required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    server = Path(ROOT) / 'testserver'
    props = dict(line.split('=', 1) for line in (server / 'server.properties').read_text().splitlines()
                 if '=' in line and not line.startswith('#'))
    cfg = json.loads((server / 'config/aiplayer/aiplayer.json').read_text())
    rcon_port, bridge_port = int(props['rcon.port']), cfg['bridgePort']
    if (props.get('level-name') != args.fixture_world or props.get('server-ip') != '127.0.0.1'
            or rcon_port != int(_local_env('AIPLAYER_TEST_RCON_PORT'))
            or bridge_port != int(_local_env('AIPLAYER_TEST_BRIDGE_PORT'))
            or rcon_port in (25575, 25576) or bridge_port in (25590, 25591)):
        raise SystemExit('Expected an explicitly selected isolated loopback test world')
    password = (server / '.rcon-password').read_text().strip()
    b = Bridge(port=bridge_port, token_file=server / 'config/aiplayer/bridge-token.txt')
    report = {'body': b.hello.get('modVersion')}
    spawned = False

    def rc(cmd):
        return run('127.0.0.1', rcon_port, password, cmd)

    def call(method, **p):
        return b.call(method, {'bot': BOT, **p})

    def transfer(spec):
        task_id = call('task.start', task=spec)['task']['id']
        result = b.wait_task(BOT, seconds=95, poll=.15)
        assert result and result['id'] == task_id, result
        return result

    def state():
        block = call('world.block', **AT, detail=True)
        saved = block.get('saved', {})
        return {'covers': saved.get('gt.covers', []), 'input': saved.get('Inventory', []),
                'observed': block.get('covers', []), 'carrying': sum(
                    i['count'] for i in call('bot.status')['inventory'] if i['id'] == 'minecraft:cobblestone')}

    def withdraw():
        return transfer({'type': 'withdraw', 'container': AT, 'fromInputs': True,
                         'items': [{'id': 'minecraft:cobblestone', 'count': 4}]})

    def washer(cover_id=None):
        # Install 12 items in the real recipe input and a nonempty redstone filter on the south face.
        extra = '' if cover_id is None else (
            ',Inventory:[{IntSlot:5,id:4s,Count:12b,Damage:0s}]'
            ',gt.covers:[{s:3b,id:%d,d:{mWhitelist:0b,filter:{Size:1,Items:[{Slot:0,id:331s,Count:1b,Damage:0s}]}}}]' % cover_id)
        rc('setblock ' + POS + ' air')
        rc('setblock ' + POS + ' gregtech:gt.blockmachines 1 replace {nbtVersion:509054265,mID:393s,mFacing:1s,mMainFacing:4' + extra + '}')
        rc('tp ' + BOT + ' 16.5 100 11.5')
        rc('clear ' + BOT)
        time.sleep(.4)
        if cover_id is not None:
            before = state()
            assert len(before['observed']) == 1 and before['observed'][0]['id'] == 'gregtech:gt.metaitem.01', before
            assert before['observed'][0]['meta'] == FILTER and before['covers'][0]['d']['filter']['Items'], before
            assert len(before['input']) == 1 and before['input'][0]['count'] == 12, before
            return before

    try:
        # Refuses an already-online name; do not take over a player or cancel anything.
        call('bot.spawn', name=BOT, x=16.5, y=100, z=11.5)
        spawned = True
        for x in range(13, 20):
            for z in range(6, 13):
                rc(f'setblock {x} 99 {z} minecraft:stone')
        walls = ('15 100 8', '17 100 8', '16 100 7')
        for p in walls:
            rc('setblock ' + p + ' air')
        rc('setblock 16 101 8 minecraft:iron_block')

        # Forge numeric IDs vary between worlds. Resolve the ID by actually installing the cover once.
        washer()
        rc(f'give {BOT} gregtech:gt.metaitem.01 1 {FILTER}')
        placed = transfer({'type': 'use', 'item': {'id': 'gregtech:gt.metaitem.01', 'meta': FILTER},
                           'on': AT, 'side': 'south', 'sneak': True, 'approach': 'current'})
        covers = state()['covers']
        assert placed['state'] == 'done' and len(covers) == 1, (placed, covers)
        cover_id = covers[0]['id']

        # The roof blocks the top: walk from the covered south face to another face without probing by clicks.
        before = washer(cover_id)
        task = withdraw()
        after = state()
        report['alternate'] = {'before': before, 'task': task, 'after': after, 'end': call('bot.status')['block']}
        assert task['state'] == 'done' and task['result']['moved'] == 4, task
        assert before['covers'] == after['covers'] and after['carrying'] == 4 and after['input'][0]['count'] == 8, after

        # Only the filter is exposed; walls/floor are not natural diggable terrain. Do not click through them.
        before = washer(cover_id)
        for p in (*walls, '16 99 8'):
            rc('setblock ' + p + ' minecraft:iron_block')
        task = withdraw()
        after = state()
        report['covered'] = {'task': task, 'after': after}
        assert task['state'] == 'failed' and before == after, 'blocked transfer must leave inventory and filter unchanged'

        # Intentionally operating the cover is still possible: its native empty-hand click clears the filter.
        rc('tp ' + BOT + ' 16.5 100 11.5')
        time.sleep(.35)
        used = transfer({'type': 'use', 'on': AT, 'side': 'south', 'approach': 'current'})
        cleared = state()
        report['explicitCover'] = {'task': used, 'after': cleared}
        assert used['state'] == 'done' and used['result']['clicks'] == 1, used
        assert cleared['covers'][0]['d']['filter']['Items'] == [] and cleared['input'] == before['input'], cleared
    finally:
        try:
            if spawned:
                call('bot.despawn')
        finally:
            b.sock.close()
            args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
