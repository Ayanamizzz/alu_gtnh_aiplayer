#!/usr/bin/env python3
"""Destructive fixture preparation ONLY for this isolated experiment (never observation/rendering)."""
import pathlib
import socket
import sys
import rcon

ROOT = pathlib.Path(__file__).resolve().parent.parent
props = (ROOT / 'testserver/server.properties').read_text()
assert '\nserver-port=10486\n' in '\n' + props + '\n'
assert '\nrcon.port=25607\n' in '\n' + props + '\n'
password = (ROOT / 'testserver/.rcon-password').read_text().strip()
sock = socket.create_connection(('127.0.0.1', 25607), timeout=15)
rcon._send(sock, 1, 3, password)
assert rcon._recv(sock)[0] != -1
seq = 1


def cmd(text):
    global seq
    seq += 1
    rcon._send(sock, seq, 2, text)
    result = rcon._recv(sock)[2]
    if 'not found' in result.lower() or 'out of' in result.lower():
        raise RuntimeError(f'{text}: {result}')
    return result


def box(a, b, block, meta=0):
    for y in range(a[1], b[1] + 1):
        for z in range(a[2], b[2] + 1):
            for x in range(a[0], b[0] + 1):
                cmd(f'setblock {x} {y} {z} minecraft:{block} {meta} replace')


def leaves(block):
    # Two cubes inside the window, another attached on the outer side. No glass is replaced.
    box((3, 182, 10), (5, 184, 11), block, 4 if block == 'leaves' else 0)
    box((2, 183, 13), (6, 185, 15), block, 4 if block == 'leaves' else 0)


action = sys.argv[1]
try:
    if action == 'build':
        cmd('gamerule doMobSpawning false')
        cmd('gamerule doDaylightCycle false')
        cmd('time set 6000')
        box((0, 180, 0), (12, 180, 17), 'grass')
        box((0, 180, 0), (12, 180, 12), 'planks')
        box((0, 186, 0), (12, 186, 12), 'planks')
        box((1, 181, 1), (11, 185, 11), 'air')
        for a, b in [((0, 181, 0), (12, 185, 0)), ((0, 181, 12), (12, 185, 12)),
                     ((0, 181, 1), (0, 185, 11)), ((12, 181, 1), (12, 185, 11))]:
            box(a, b, 'planks')
        box((2, 182, 12), (6, 184, 12), 'glass')
        box((9, 181, 12), (10, 183, 12), 'air')  # Actual open doorway, not a cutaway wall.
        box((4, 181, 15), (4, 185, 15), 'log')
        box((2, 181, -2), (10, 185, -2), 'wool', 14)
        leaves('leaves')
        print(cmd('tp VisionProbe 6.5 181 5.5'))
    elif action == 'clean':
        leaves('air')
    elif action == 'leaves':
        leaves('leaves')
    elif action == 'hidden':
        box((2, 181, -2), (10, 185, -2), 'wool', 11)
    else:
        raise ValueError(action)
    print(f'{action}: {seq - 1} fixture commands completed')
finally:
    sock.close()
