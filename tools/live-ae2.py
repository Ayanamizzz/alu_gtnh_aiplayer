#!/usr/bin/env python3
"""Real body + real Applied Energistics 2 on THIS checkout's isolated testserver only.

Builds a small ME network on a platform in the test world and runs the ordinary entry points against it:
world.containers / world.stock (what a terminal shows), deposit / withdraw tasks through the terminal (exact
counts), and what happens when the network is dark, full, or asked for more than it has. RCON only arranges the
arena and the bot's inventory; the cables and terminals are placed by the bot with the ordinary `use` task, the
storage cell is put into the drive with an ordinary `deposit`.

  python3 tools/live-ae2.py --out /tmp/ae2.json

Overwrites x=40..54, y=200..205, z=40..50 of the overworld in the test world.
Last run on GTNH 2.9.0 (AE2 rv3-beta-1095): 23 of 23.
"""
import argparse
import json
import os
import sys
import time

from bridge import Bridge, ROOT, _local_env
from rcon import run

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
a = ap.parse_args()

BOT = "MeQA"
Y = 201
CELL_POWER = (44, Y, 44)   # creative energy cell
DRIVE = (45, Y, 44)        # ME drive, touching it
CABLE1 = (46, Y, 44)       # glass cable placed against the drive, terminal on its south face
CABLE2 = (47, Y, 44)       # a second cable and terminal of the same network
CABLE3 = (48, Y, 44)       # a third cable, with a crafting terminal
CHEST = (50, Y, 46)        # an ordinary chest next to it all
PART = "appliedenergistics2:item.ItemMultiPart"
CABLE_META, TERMINAL_META, CRAFTING_TERMINAL_META = 16, 380, 360
STONE = "minecraft:cobblestone"
IRON = "minecraft:iron_ingot"

b = Bridge()
password = open(os.path.join(ROOT, "testserver/.rcon-password")).read().strip()
port = int(_local_env("AIPLAYER_TEST_RCON_PORT") or "25576")
report = {"steps": []}
failures = []


def rc(cmd):
    # The arena is some nine hundred commands, each its own connection; the server now and then drops one.
    for attempt in range(4):
        try:
            return run("127.0.0.1", port, password, cmd)
        except (ConnectionError, OSError):
            if attempt == 3:
                raise
            time.sleep(0.5)


def call(method, **params):
    return b.call(method, params)


def task(spec, seconds=60):
    call("task.start", bot=BOT, task=spec)
    try:
        return b.wait_task(BOT, seconds)
    except TimeoutError:
        active = call("task.list", bot=BOT)["active"]
        call("task.cancel", bot=BOT)
        return {"state": "timeout", "active": active}


def pos(p):
    return {"x": p[0], "y": p[1], "z": p[2]}


def inventory():
    return call("bot.status", bot=BOT).get("inventory", [])


def carried(item, meta=None):
    n = 0
    for s in inventory():
        if s.get("id") == item and (meta is None or s.get("meta") == meta):
            n += s.get("count", 0)
    return n


def containers(center, radius=8):
    return call("world.containers", x=center[0], y=center[1], z=center[2], radius=radius, kinds=2000)["containers"]


def at(found, p):
    for c in found:
        if (c["x"], c["y"], c["z"]) == p:
            return c
    return None


def stored(terminal, item):
    for it in (terminal or {}).get("items", []):
        if it["id"] == item:
            return it["count"]
    return 0


def check(name, ok, detail):
    report["steps"].append({"name": name, "ok": bool(ok), "detail": detail})
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else "  " + json.dumps(detail, ensure_ascii=False)[:600]), flush=True)
    if not ok:
        failures.append(name)


def summary(t):
    """What matters of a finished task."""
    if not t:
        return None
    return {k: t.get(k) for k in ("type", "state", "result", "error") if t.get(k) is not None}


def fresh_inventory(*gives):
    rc("clear " + BOT)
    for item, count, meta in gives:
        rc(f"give {BOT} {item} {count} {meta}")
    time.sleep(0.4)


try:
    # ---- the arena ----------------------------------------------------------------------------------------------
    try:
        online = call("bot.status", bot=BOT).get("online")
    except RuntimeError:
        online = False
    if not online:
        call("bot.spawn", name=BOT, x=48.5, y=Y + 6, z=47.5)
    call("task.cancel", bot=BOT)
    rc(f"tp {BOT} 48.5 {Y + 6} 47.5")
    time.sleep(1.5)
    for x in range(40, 55):
        for z in range(40, 51):
            rc(f"setblock {x} {Y - 1} {z} minecraft:stone 0 replace")
            for y in range(Y, Y + 5):
                rc(f"setblock {x} {y} {z} minecraft:air 0 replace")
    rc("cofh killall item")
    rc("setblock %d %d %d appliedenergistics2:tile.BlockCreativeEnergyCell 0 replace" % CELL_POWER)
    rc("setblock %d %d %d appliedenergistics2:tile.BlockDrive 0 replace" % DRIVE)
    rc("setblock %d %d %d minecraft:chest 0 replace" % CHEST)
    rc(f"tp {BOT} 46.5 {Y} 47.5")
    time.sleep(1.0)
    report["blocks"] = {k: call("world.block", **pos(p)).get("id") for k, p in (("power", CELL_POWER), ("drive", DRIVE))}

    # The bot builds the rest as a player would: a storage cell into the drive, cables against it, terminals on them.
    fresh_inventory((PART, 2, CABLE_META), (PART, 2, TERMINAL_META), ("appliedenergistics2:item.ItemBasicStorageCell.1k", 1, 0))
    report["kit"] = inventory()
    t = task({"type": "deposit", "container": pos(DRIVE), "items": [{"id": "appliedenergistics2:item.ItemBasicStorageCell.1k"}]})
    check("a storage cell goes into the ME drive by an ordinary deposit", t and t.get("state") == "done", summary(t))
    # Sneaking, as a player does to put something against a block that would otherwise open its screen.
    t = task({"type": "use", "item": {"id": PART, "meta": CABLE_META}, "on": pos(DRIVE), "side": "east", "sneak": True})
    c1 = call("world.block", **pos(CABLE1))
    check("the bot places a cable against the drive", c1.get("id") == "appliedenergistics2:tile.BlockCableBus", {"task": summary(t), "block": c1})
    t = task({"type": "use", "item": {"id": PART, "meta": CABLE_META}, "on": pos(CABLE1), "side": "east"})
    c2 = call("world.block", **pos(CABLE2))
    check("and a second cable next to it", c2.get("id") == "appliedenergistics2:tile.BlockCableBus", {"task": summary(t), "block": c2})
    for name, cable in (("first", CABLE1), ("second", CABLE2)):
        t = task({"type": "use", "item": {"id": PART, "meta": TERMINAL_META}, "on": pos(cable), "side": "south"})
        report[f"terminal_{name}_placed"] = summary(t)
    time.sleep(2.0)  # the network boots: channels are handed out a moment after the last block joins

    # ---- what the body says about it ------------------------------------------------------------------------------
    found = containers(CABLE1)
    t1, t2 = at(found, CABLE1), at(found, CABLE2)
    report["containers_empty_network"] = [t1, t2]
    check(
        "both terminals are listed as ME terminals on their south face, lit, of one network",
        t1 and t2 and t1.get("kind") == "me_terminal" == t2.get("kind") and t1.get("side") == "south" and t1.get("online") is True
        and t2.get("online") is True and t1.get("network") and t1.get("network") == t2.get("network"),
        [t1, t2],
    )
    check(
        "only the nearer one carries the list; the other names it",
        t1 and t2 and "sameNetworkAs" not in t1 and t2.get("sameNetworkAs") == pos(CABLE1) and t2.get("items") == [],
        [t1, t2],
    )

    # ---- deposit: a whole stack, then part of a stack -------------------------------------------------------------
    fresh_inventory((STONE, 64, 0), (STONE, 64, 0), (STONE, 64, 0), (STONE, 8, 0), (IRON, 10, 0))
    had = carried(STONE)
    t = task({"type": "deposit", "container": pos(CABLE1), "items": [{"id": STONE, "meta": 0, "count": 100}]})
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    check("deposit 100 of 200 cobblestone: exactly 100 in the network, 100 still carried", t and t.get("state") == "done" and net == 100 and carried(STONE) == had - 100, {"task": summary(t), "network": net, "carried": carried(STONE), "had": had})
    check("the iron that was not asked for stayed", carried(IRON) == 10, carried(IRON))

    # ---- the network seen from elsewhere --------------------------------------------------------------------------
    stock = call("world.stock", x=CABLE1[0], y=Y, z=CABLE1[2], radius=16, items=[{"id": STONE, "meta": 0}, {"id": IRON}])
    report["stock"] = stock
    s0 = stock["items"][0]
    check(
        "world.stock finds it in the network once, at the nearest terminal",
        s0["total"] == 100 and len(s0["places"]) == 1 and s0["places"][0].get("kind") == "me_terminal" and (s0["places"][0]["x"], s0["places"][0]["y"], s0["places"][0]["z"]) == CABLE1,
        s0,
    )

    # ---- withdraw: a stack and a bit, exact -----------------------------------------------------------------------
    rc(f"tp {BOT} 46.5 {Y} 42.5")  # behind the terminals: it has to walk round to their front
    time.sleep(0.6)
    had = carried(STONE)
    t = task({"type": "withdraw", "container": pos(CABLE2), "items": [{"id": STONE, "meta": 0, "count": 70}]})
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    where = call("bot.status", bot=BOT).get("pos")
    check("withdraw 70 through the other terminal, starting behind it: exactly 70 came, 30 left in the network", t and t.get("state") == "done" and carried(STONE) == had + 70 and net == 30, {"task": summary(t), "network": net, "carried": carried(STONE), "had": had, "stoodAt": where})

    # ---- asking for more than there is ----------------------------------------------------------------------------
    had = carried(STONE)
    t = task({"type": "withdraw", "container": pos(CABLE1), "items": [{"id": STONE, "meta": 0, "count": 500}]})
    missing = ((t or {}).get("result") or {}).get("missing")
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    check("asking for 500 when 30 are there: the 30 come, the task is done and says 470 are missing", t and t.get("state") == "done" and carried(STONE) == had + 30 and net == 0 and missing and missing[0].get("count") == 470, {"task": summary(t), "network": net, "carried": carried(STONE)})

    # ---- everything but tools, as a dump ---------------------------------------------------------------------------
    t = task({"type": "deposit", "container": pos(CABLE1)})
    found = containers(CABLE1)
    net_stone, net_iron = stored(at(found, CABLE1), STONE), stored(at(found, CABLE1), IRON)
    check("deposit without a list: all 200 cobblestone and 10 iron go in", t and t.get("state") == "done" and net_stone == 200 and net_iron == 10 and carried(STONE) == 0 and carried(IRON) == 0, {"task": summary(t), "stone": net_stone, "iron": net_iron})

    # ---- a full inventory ------------------------------------------------------------------------------------------
    fresh_inventory(*[("minecraft:stick", 64, 0)] * 36)
    t = task({"type": "withdraw", "container": pos(CABLE1), "items": [{"id": STONE, "meta": 0, "count": 5}]})
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    check("with no room at all: inventory_full, nothing left the network", t and t.get("state") == "failed" and (t.get("error") or {}).get("code") == "inventory_full" and net == 200, {"task": summary(t), "network": net})

    # ---- a network with no room: the 1k cell fills up ----------------------------------------------------------------
    # A 1k cell holds 63 kinds at most and two are in it already. 32 more go in; of the next 32 only 29 can.
    fresh_inventory(*[("minecraft:wool", 1, m) for m in range(16)], *[("minecraft:stained_hardened_clay", 1, m) for m in range(16)])
    t = task({"type": "deposit", "container": pos(CABLE1)}, 120)
    kinds = (at(containers(CABLE1), CABLE1) or {}).get("kinds")
    check("32 more kinds fit into the 1k cell: 34 kinds stored", t and t.get("state") == "done" and kinds == 34 and not inventory(), {"task": summary(t), "kinds": kinds})
    fresh_inventory(*[("minecraft:stained_glass", 1, m) for m in range(16)], *[("minecraft:carpet", 1, m) for m in range(16)])
    before = sum(s.get("count", 0) for s in inventory())
    t = task({"type": "deposit", "container": pos(CABLE1)}, 120)
    after = sum(s.get("count", 0) for s in inventory())
    kinds = (at(containers(CABLE1), CABLE1) or {}).get("kinds")
    check("32 kinds more than the cell's 63: container_full, 29 went in, the 3 that did not fit are still carried", t and t.get("state") == "failed" and (t.get("error") or {}).get("code") == "container_full" and before == 32 and after == 3 and kinds == 63, {"task": summary(t), "carriedBefore": before, "carriedAfter": after, "kinds": kinds})

    # ---- dark: the power is taken away ------------------------------------------------------------------------------
    rc("setblock %d %d %d minecraft:air 0 replace" % CELL_POWER)
    time.sleep(3.0)
    dark = at(containers(CABLE1), CABLE1)
    report["dark"] = dark
    check("without power the terminal is listed as not online, with nothing in it", dark and dark.get("online") is False and dark.get("items") == [], dark)
    fresh_inventory((IRON, 3, 0))
    t = task({"type": "withdraw", "container": pos(CABLE1), "items": [{"id": STONE, "meta": 0, "count": 5}]})
    check("withdrawing from a dark terminal fails as denied and says why", t and t.get("state") == "failed" and (t.get("error") or {}).get("code") == "denied" and "dark" in (t.get("error") or {}).get("message", ""), summary(t))
    t = task({"type": "deposit", "container": pos(CABLE1), "items": [{"id": IRON}]})
    check("so does depositing, and the iron stays in hand", t and t.get("state") == "failed" and (t.get("error") or {}).get("code") == "denied" and carried(IRON) == 3, {"task": summary(t), "carried": carried(IRON)})
    rc("setblock %d %d %d appliedenergistics2:tile.BlockCreativeEnergyCell 0 replace" % CELL_POWER)
    time.sleep(3.0)
    lit = at(containers(CABLE1), CABLE1)
    check("with power back the same things are there again", lit and lit.get("online") is True and stored(lit, STONE) == 200, lit)

    # ---- an ordinary chest next to it still works as before ---------------------------------------------------------
    t = task({"type": "deposit", "container": pos(CHEST), "items": [{"id": IRON, "count": 2}]})
    chest = at(containers(CHEST, 0), CHEST)
    check("a plain chest beside the network is unaffected: 2 of 3 iron go in", t and t.get("state") == "done" and stored(chest, IRON) == 2 and carried(IRON) == 1, {"task": summary(t), "chest": chest})

    # ---- carrying a whole source is refused for a network -------------------------------------------------------------
    t = task({"type": "haul", "from": pos(CABLE1), "to": pos(CHEST)})
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    check("haul without a list from a terminal is refused; the network is not emptied", t and t.get("state") == "failed" and net == 200, {"task": summary(t), "network": net})

    # ---- a few of a stack: the other way of splitting ------------------------------------------------------------------
    fresh_inventory((STONE, 64, 0))
    before = stored(at(containers(CABLE1), CABLE1), STONE)
    t = task({"type": "deposit", "container": pos(CABLE1), "items": [{"id": STONE, "meta": 0, "count": 5}]})
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    check("deposit 5 of a stack of 64: exactly 5 more in the network, 59 still carried", t and t.get("state") == "done" and net == before + 5 and carried(STONE) == 59, {"task": summary(t), "before": before, "network": net, "carried": carried(STONE)})

    # ---- a crafting terminal is the same list ---------------------------------------------------------------------------
    fresh_inventory((PART, 1, CABLE_META), (PART, 1, CRAFTING_TERMINAL_META))
    task({"type": "use", "item": {"id": PART, "meta": CABLE_META}, "on": pos(CABLE2), "side": "east"})
    task({"type": "use", "item": {"id": PART, "meta": CRAFTING_TERMINAL_META}, "on": pos(CABLE3), "side": "south"})
    time.sleep(2.0)
    found = containers(CABLE3)
    t3 = at(found, CABLE3)
    check("a crafting terminal is listed as an ME terminal of the same network", t3 and t3.get("kind") == "me_terminal" and t3.get("online") is True and t3.get("network") == (at(found, CABLE1) or {}).get("network"), t3)
    before = stored(at(containers(CABLE1), CABLE1), STONE)
    t = task({"type": "withdraw", "container": pos(CABLE3), "items": [{"id": STONE, "meta": 0, "count": 7}]})
    net = stored(at(containers(CABLE1), CABLE1), STONE)
    check("withdraw 7 through the crafting terminal: exactly 7", t and t.get("state") == "done" and carried(STONE) == 7 and net == before - 7, {"task": summary(t), "before": before, "network": net, "carried": carried(STONE)})
finally:
    report["failures"] = failures
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    print(f"{len(report['steps']) - len(failures)} of {len(report['steps'])} checks passed; report in {a.out}", flush=True)

sys.exit(1 if failures else 0)
