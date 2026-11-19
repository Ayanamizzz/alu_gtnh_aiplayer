#!/usr/bin/env python3
"""Exercise the real dig task over an eight-block shaft, on a disposable loopback testserver.

python3 tools/live-dig-footing.py --world World-fb4-support --out /tmp/footing.json
Requires this checkout's tools/local.env with explicit test ports. Rebuilds the fixture at
(1920,192..202,83) in the named test world. RCON only prepares the world/player; excavation
and movement use the body, and the verdict comes from world.block, bot.status and task.list.
"""
import argparse
import base64
import gzip
import json
from pathlib import Path
import struct
import time

from bridge import Bridge, ROOT, _local_env
from rcon import run


BOT = 'FootingQA'
X, Y, Z = 1920, 200, 83
TARGET = {'x': X, 'y': Y, 'z': Z}
AIR, DIRT, STONE = ['minecraft:' + b for b in ('air', 'dirt', 'stone')]


def sandbox(world):
    ts = Path(ROOT) / 'testserver'
    props = dict(line.split('=', 1) for line in (ts / 'server.properties').read_text().splitlines()
                 if '=' in line and not line.startswith('#'))
    cfg = json.loads((ts / 'config/aiplayer/aiplayer.json').read_text())
    def port(kind):
        return int(_local_env('AIPLAYER_TEST_' + kind + '_PORT'))
    if (props.get('server-ip') != '127.0.0.1' or props.get('level-name') != world
            or world not in ('World-fb4', 'World-fb4-support')
            or (ts / world).resolve().parent != ts.resolve() or not (ts / world).is_dir()
            or int(props['server-port']) != port('GAME') or int(props['rcon.port']) != port('RCON')
            or cfg.get('bridgeHost') != '127.0.0.1' or cfg['bridgePort'] != port('BRIDGE')):
        raise SystemExit('Refusing: checkout does not describe the requested private fb4 test world / loopback ports')
    return (Bridge(port('BRIDGE'), ts / 'config/aiplayer/bridge-token.txt'),
            port('RCON'), (ts / '.rcon-password').read_text().strip())


def glass_schematic():
    """One vanilla glass cell for the real blueprint clear-then-place task (Schematica NBT)."""
    def tag(kind, name, value):
        return struct.pack('>BH', kind, len(name)) + name.encode() + value
    size = b''.join(tag(2, axis, struct.pack('>h', 1)) for axis in ('Width', 'Height', 'Length'))
    cell = tag(7, 'Blocks', b'\x00\x00\x00\x01\x14') + tag(7, 'Data', b'\x00\x00\x00\x01\x00')
    mapping = tag(10, 'SchematicaMapping', tag(2, 'minecraft:glass', struct.pack('>h', 20)) + b'\x00')
    return base64.b64encode(gzip.compress(tag(10, 'Schematic', size + cell + mapping + b'\x00'))).decode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    bridge, port, pw = sandbox(args.world)
    report = {}
    def rc(cmd):
        return run('127.0.0.1', port, pw, cmd)
    def put(x, y, block):
        rc(f'setblock {x} {y} {Z} {block} 0 replace')
    def call(method, **params):
        return bridge.call(method, dict(bot=BOT, **params))
    def body():
        s = call('bot.status')
        return {key: s[key] for key in ('pos', 'onGround', 'inWater')}
    def block(x, y):
        return call('world.block', x=x, y=y, z=Z)['id']
    def teleport(x, feet):
        rc(f'tp {BOT} {x} {feet:.1f} {Z + 0.5}')
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            b = body()
            if b['onGround'] and b['pos'] == dict(x=x, y=feet, z=Z+0.5):
                return b
        raise AssertionError(f'fixture teleport did not settle at {(x, feet)}: {b}')

    try:
        online = call('bot.status')['online']
    except RuntimeError:
        online = False
    if not online:
        call('bot.spawn', name=BOT, x=X+.5, y=Y+1, z=Z+.5)
    call('task.cancel')
    rc('clear ' + BOT)
    try:
        # The seven air cells above the stone floor and the cap itself span an eight-block drop.
        put(X, Y-8, STONE)
        put(X-1, Y, AIR)
        put(X+1, Y, AIR)
        for y in range(Y-7, Y+1):
            put(X, y, AIR)
        # Do not mistake pre-existing terrain in a reused world for an isolated shaft or another usable ledge.
        empty = call('world.blocks', x1=X-4, x2=X+4, y1=Y-7, y2=Y+3, z1=Z-4, z2=Z+4)
        assert empty['unloaded'] == 0 and empty['runs'] == [0, 9 * 11 * 9], empty
        #             standing x, available side, block at Y-1, cap, initial feet Y, limit, expected
        cases = [
            ('isolated',       X+.5, False, AIR,   DIRT, Y+1, 3, 'keep'),
            ('walk_aside',     X+.5, True,  AIR,   DIRT, Y+1, 3, 'beside'),
            # Centre in air, but the trailing edge of the body still rests on the target. Walk back across
            # it to the +x ledge; the rounded -x air cell isn't an already-reached stance.
            ('overhanging',    X-.1, True,  AIR,   DIRT, Y+1, 3, 'beside'),
            ('already_beside', X+1.5, True, AIR,   DIRT, Y+1, 0, 'beside'),
            ('edge_supported', X+.9, True,  AIR,   DIRT, Y+1, 0, 'edge'),
            # Only the far half of this stair reaches the cap's height. Start in the stair's cell but with
            # the real body still supported solely by dirt; move onto its upper tread before digging.
            ('stair_edge',     X+1.05, 'minecraft:oak_stairs', AIR, DIRT, Y+1, 0, 'beside'),
            ('shallow',        X+.5, False, STONE, DIRT, Y+1, 1, 'down_one'),
            ('no_drop',        X+.5, False, STONE, DIRT, Y+1, 0, 'keep'),
            ('explicit_eight', X+.5, False, AIR,   DIRT, Y+1, 8, 'down_eight'),
            ('slab_cap',       X+.5, False, AIR, 'minecraft:wooden_slab', Y+.5, 3, 'keep'),
        ]
        for name, x, side, below, cap, feet, limit, expected in cases:
            ledge = side if isinstance(side, str) else STONE if side else AIR
            put(X+1, Y, ledge)
            put(X, Y-1, below)
            put(X, Y, cap)
            before = teleport(x, feet)
            column = {y: block(X, y) for y in range(Y-8, Y+1)}
            assert column == {y: STONE if y == Y-8 else below if y == Y-1 else cap if y == Y else AIR
                              for y in range(Y-8, Y+1)}, column
            side_before = block(X+1, Y)
            assert side_before == ledge, side_before
            call('task.start', task={'type': 'dig', 'blocks': [TARGET], 'dig': False, 'climb': False, 'maxDrop': limit})
            task = bridge.wait_task(BOT, 45, poll=.15)
            time.sleep(.9)  # A finished dig can have put the body in mid-air; read its actual landing.
            after, cap_after = body(), block(X, Y)
            r = task['result']
            actual_y = after['pos']['y']
            ok = (task['state'] == 'done' and after['onGround']
                  and cap_after == (cap if expected == 'keep' else AIR)
                  and r['removed'] == (0 if expected == 'keep' else 1))
            if expected == 'keep':
                ok &= (actual_y == feet and any('maxDrop=' + str(limit) in s['reason'] and
                       all(s.get(k) == v for k, v in TARGET.items()) for s in r.get('skippedExamples', [])))
            elif expected == 'beside':
                ok &= actual_y == feet and int(after['pos']['x']) == X+1
            elif expected == 'edge':
                ok &= after['pos'] == before['pos']
            else:
                ok &= actual_y == feet - (1 if expected == 'down_one' else 8)
            report[name] = dict(before=before, column=column, side=side_before, task=task,
                                after=after, capAfter=cap_after, ok=ok)
            if name == 'isolated':
                report[name]['arenaBeforeCaps'] = empty
            print(f'{name}: {before["pos"]} -> {after["pos"]}, cap={cap_after}, {r}, ok={ok}', flush=True)
        # The first instant break is legal (one block to land). Shears start on the second named
        # leaf before the body lands; it must not take away the only remaining floor mid-fall.
        put(X+1, Y, AIR)
        for level in [Y, Y-1]:
            rc(f'setblock {X} {level} {Z} minecraft:leaves 4 replace')
        rc(f'give {BOT} minecraft:shears')
        before = teleport(X+.5, Y+1)
        lower = {**TARGET, 'y': Y-1}
        call('task.start', task={'type': 'dig', 'blocks': [TARGET, lower], 'dig': False, 'climb': False, 'maxDrop': 3})
        task = bridge.wait_task(BOT, 45)
        time.sleep(.9)
        after = body()
        caps = [block(X, y) for y in (Y, Y-1)]
        ok = (task['state'] == 'done' and task['result']['removed'] == 1 and caps == [AIR, 'minecraft:leaves']
              and any(all(s[k] == v for k, v in lower.items()) for s in task['result'].get('skippedExamples', []))
              and after['pos']['y'] == Y and after['onGround'])
        report['instant_two_layers'] = dict(before=before, after=after, task=task, caps=caps, ok=ok)
        print('instant_two_layers:', task['result'], after, caps, 'ok=', ok, flush=True)
        # World changed during a long swing: the old side disappears and a push puts the player back
        # on the target. The final click must check the new footing, not trust the earlier walk result.
        put(X, Y-1, AIR)
        put(X+1, Y, STONE)
        put(X, Y, 'minecraft:log')
        before = teleport(X+.5, Y+1)
        call('task.start', task={'type': 'dig', 'blocks': [TARGET], 'dig': False, 'climb': False, 'maxDrop': 3})
        deadline = time.monotonic() + 8
        beside = None
        while time.monotonic() < deadline:
            b = body()
            if b['onGround'] and int(b['pos']['x']) == X+1:
                beside = b
                break
        if beside:
            time.sleep(.6)  # no axe: a log takes several seconds by hand
            rc(f'tp {BOT} {X+.5} {Y+1:.1f} {Z+.5}')
            put(X+1, Y, AIR)
        task = bridge.wait_task(BOT, 45)
        time.sleep(.9)
        after, cap_after = body(), block(X, Y)
        ok = bool(beside and task['state'] == 'done' and task['result']['removed'] == 0
                  and task['result'].get('skippedExamples') and cap_after == 'minecraft:log'
                  and after['pos']['y'] == Y+1 and after['onGround'])
        report['displaced_while_digging'] = dict(before=before, beside=beside, task=task, after=after, capAfter=cap_after, ok=ok)
        print('displaced_while_digging:', task['result'], after, 'ok=', ok, flush=True)

        # One target must still mean one cell after relocation, including a replacement at that exact cell.
        blueprint = 'footing-qa-glass'
        call('blueprint.put', name=blueprint, data=glass_schematic())
        rc(f'give {BOT} minecraft:glass 2')
        for side in (False, True):
            put(X+1, Y, STONE if side else AIR)
            put(X, Y, DIRT)
            before = teleport(X+.5, Y+1)
            call('task.start', task={'type': 'blueprint', 'name': blueprint, **TARGET, 'clear': [DIRT],
                                     'dig': False, 'climb': False, 'maxDrop': 3})
            task = bridge.wait_task(BOT, 120)
            time.sleep(.9)
            after, cap_after = body(), block(X, Y)
            r = task['result']
            ok = (task['state'] == 'done' and after['pos']['y'] == Y+1 and after['onGround']
                  and r['removed'] == int(side) and r['placed'] == int(side)
                  and cap_after == ('minecraft:glass' if side else DIRT)
                  and (side or bool(r.get('skippedExamples'))))
            name = 'replace_with_side' if side else 'replace_without_side'
            report[name] = dict(before=before, task=task, after=after, capAfter=cap_after, ok=ok)
            print(name, task['result'], after, cap_after, 'ok=', ok, flush=True)
    finally:
        call('task.cancel')
        args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
        bridge.sock.close()
    if not all(t['ok'] for t in report.values()):
        raise SystemExit('Failed: ' + ', '.join(k for k, t in report.items() if not t['ok']))


if __name__ == '__main__':
    main()
