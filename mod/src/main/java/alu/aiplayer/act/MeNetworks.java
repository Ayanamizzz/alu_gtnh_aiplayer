package alu.aiplayer.act;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraftforge.common.util.ForgeDirection;

import alu.aiplayer.AiPlayerMod;
import cpw.mods.fml.common.Loader;

/**
 * Applied Energistics 2, used the way a player uses it: through a terminal. A terminal is a part on one face of a
 * cable; right-clicking that face opens a screen that lists everything the ME network stores, with real counts, and
 * takes and stores items by clicks.
 * <p>
 * The list is not made of slots: a client draws it from what the server sends, and a click on one of its entries
 * reaches the server as "this stack, this kind of click". The body does that client half: it reads the list the
 * open screen would be sent ({@link #stored}) and makes the clicks by calling what the server runs when a client's
 * click arrives ({@link #click}), so the network's own rules (power, security, how much one click moves) all apply.
 * The bot's own inventory in that screen is ordinary slots, and a shift-click on one stores the stack in the network,
 * as it does for a player.
 * <p>
 * Looking at a network without opening anything ({@link #view}) reads what a terminal of it would show, the way
 * chests and drawers are looked into.
 * <p>
 * The mod is optional. Everything of it is touched only inside {@link Ae2}, which is not loaded unless the mod is
 * there; in a form this code does not know, terminals are simply not recognised.
 */
public final class MeNetworks {

    private MeNetworks() {}

    /** One kind of item a network stores. */
    public static final class Stored {

        /** One item of the kind. */
        public final ItemStack prototype;
        public final long count;

        Stored(ItemStack prototype, long count) {
            this.prototype = prototype;
            this.count = count;
        }
    }

    /** What one terminal shows of its network, without opening it. */
    public static final class View {

        /** The face of the block the terminal is on (0 down .. 5 east). */
        public final int side;
        /** The terminal's own name ("ME Terminal", "ME Crafting Terminal"). */
        public final String name;
        /** False when the terminal is dark: no power, no channel, or not joined to a network yet. */
        public final boolean online;
        /** The same object for every terminal of one network, for as long as the network stays as it is. */
        public final Object network;
        /** A name for that network that can be told apart in text: where its first block is. Null when offline. */
        public final String networkId;
        /** Empty when offline. */
        public final List<Stored> stored;

        View(int side, String name, boolean online, Object network, String networkId, List<Stored> stored) {
            this.side = side;
            this.name = name;
            this.online = online;
            this.network = network;
            this.networkId = networkId;
            this.stored = stored;
        }
    }

    /** The clicks on an entry of a terminal's list, as the server names them. */
    public enum Click {
        /** Shift and left: a stack of that kind straight into the inventory, as much of one as there is room for. */
        TAKE_STACK,
        /** Left: with an empty cursor, a stack of that kind onto it; with a full one, all of it into the network. */
        PICK_UP_OR_PUT_DOWN,
        /** Right: with an empty cursor, half a stack onto it; with a full one, one item of it into the network. */
        SPLIT_OR_PUT_ONE
    }

    private static boolean looked;
    private static boolean usable;

    private static synchronized boolean available() {
        if (looked) return usable;
        looked = true;
        if (!Loader.isModLoaded("appliedenergistics2")) return false;
        try {
            Ae2.check();
            usable = true;
        } catch (Throwable t) {
            usable = false;
            AiPlayerMod.LOG.warn("Applied Energistics 2 is installed but not in a form this mod knows; ME terminals are not used", t);
        }
        return usable;
    }

    /** The faces of this block that carry a terminal (0 down .. 5 east); empty for anything else. */
    public static int[] terminalSides(TileEntity te) {
        if (te == null || !available()) return NONE;
        try {
            return Ae2.terminalSides(te);
        } catch (Throwable t) {
            return NONE;
        }
    }

    private static final int[] NONE = new int[0];

    public static boolean isTerminalHost(TileEntity te) {
        return terminalSides(te).length > 0;
    }

    /**
     * The terminal of this block to use: the one on the face the player's eyes are in front of, else one on a
     * side face (those can be walked up to), else whichever there is. -1 when the block carries none.
     */
    public static int terminalSide(TileEntity te, EntityPlayerMP p) {
        int[] sides = terminalSides(te);
        if (sides.length == 0) return -1;
        if (p != null) {
            for (int s : sides) if (Drawers.inFront(p, te.xCoord, te.yCoord, te.zCoord, s)) return s;
        }
        for (int s : sides) if (s >= 2) return s;
        return sides[0];
    }

    /** What the terminal on that face shows; null when there is none there or it cannot be read. */
    public static View view(TileEntity te, int side) {
        if (te == null || side < 0 || side > 5 || !available()) return null;
        try {
            return Ae2.view(te, side, true);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Cannot read an ME network", t);
            return null;
        }
    }

    /** As {@link #view} without the list of what is stored: which network it is and whether it is on. */
    public static View glance(TileEntity te, int side) {
        if (te == null || side < 0 || side > 5 || !available()) return null;
        try {
            return Ae2.view(te, side, false);
        } catch (Throwable t) {
            return null;
        }
    }

    /** Whether the open screen is a terminal's: one whose list of stored items is clicked through {@link #click}. */
    public static boolean isTerminalScreen(Container c) {
        if (c == null || !available()) return false;
        try {
            return Ae2.isScreen(c);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Whether the open terminal screen is lit: a dark one lists nothing and moves nothing. */
    public static boolean screenOnline(Container c) {
        try {
            return Ae2.online(c);
        } catch (Throwable t) {
            return false;
        }
    }

    /** What the open terminal screen lists, most first. */
    public static List<Stored> stored(Container c) {
        try {
            return Ae2.stored(c);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Cannot read what an ME terminal lists", t);
            return Collections.emptyList();
        }
    }

    /**
     * One click on the entry of the open terminal's list that shows this kind of item ({@code target} null for a
     * click on the list where no entry is, which is where a held stack is put down). What it moved is told from the
     * inventory and the cursor afterwards, as with any click.
     */
    public static void click(Container c, EntityPlayerMP p, ItemStack target, Click click) {
        try {
            Ae2.click(c, p, target, click);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("A click in an ME terminal failed", t);
        }
    }

    /** Everything that names Applied Energistics 2. Loaded only when the mod is. */
    private static final class Ae2 {

        /** Fails when the classes this needs are not what it was written against. */
        static void check() throws Exception {
            appeng.container.implementations.ContainerMEMonitorable.class.getMethod(
                "doMonitorableAction",
                appeng.helpers.MonitorableAction.class,
                int.class,
                EntityPlayerMP.class);
            appeng.container.AEBaseContainer.class.getMethod("setTargetStack", appeng.api.storage.data.IAEStack.class);
            appeng.container.AEBaseContainer.class.getMethod("getTarget");
        }

        /**
         * A terminal whose screen is the network's list: the plain, crafting and pattern terminals. Other mods add
         * terminals of their own with screens of their own, and the crafting diagnostic terminal shows no list at
         * all; those are left to the generic screen handling.
         */
        private static boolean isTerminal(appeng.api.parts.IPart part) {
            return part instanceof appeng.parts.reporting.AbstractPartTerminal
                && !(part instanceof appeng.parts.reporting.PartCraftingDiagnosticTerminal)
                && part.getClass()
                    .getName()
                    .startsWith("appeng.");
        }

        static int[] terminalSides(TileEntity te) {
            if (!(te instanceof appeng.api.parts.IPartHost)) return NONE;
            appeng.api.parts.IPartHost host = (appeng.api.parts.IPartHost) te;
            int n = 0;
            int[] found = new int[6];
            for (ForgeDirection d : ForgeDirection.VALID_DIRECTIONS) {
                if (isTerminal(host.getPart(d))) found[n++] = d.ordinal();
            }
            return n == 0 ? NONE : java.util.Arrays.copyOf(found, n);
        }

        static View view(TileEntity te, int side, boolean withList) {
            if (!(te instanceof appeng.api.parts.IPartHost)) return null;
            appeng.api.parts.IPart part = ((appeng.api.parts.IPartHost) te).getPart(ForgeDirection.getOrientation(side));
            if (!isTerminal(part)) return null;
            String name = "ME Terminal";
            try {
                ItemStack item = part.getItemStack(appeng.api.parts.PartItemStack.Pick);
                if (item != null) name = alu.aiplayer.util.Names.displayName(item);
            } catch (Throwable ignored) {}
            appeng.api.networking.IGridNode node = part.getGridNode();
            appeng.api.networking.IGrid grid = node == null ? null : node.getGrid();
            if (grid == null || !node.isActive()) return new View(side, name, false, grid, null, Collections.<Stored>emptyList());
            String id = null;
            try {
                appeng.api.util.DimensionalCoord at = grid.getPivot()
                    .getGridBlock()
                    .getLocation();
                id = at.getDimension() + ":" + at.x + "," + at.y + "," + at.z;
            } catch (Throwable ignored) {}
            List<Stored> stored = Collections.emptyList();
            if (withList) {
                appeng.api.networking.storage.IStorageGrid storage = grid.getCache(appeng.api.networking.storage.IStorageGrid.class);
                stored = list(storage.getItemInventory());
            }
            return new View(side, name, true, grid, id, stored);
        }

        private static List<Stored> list(appeng.api.storage.IMEMonitor<appeng.api.storage.data.IAEItemStack> monitor) {
            List<Stored> out = new ArrayList<>();
            if (monitor == null) return out;
            for (appeng.api.storage.data.IAEItemStack s : monitor.getStorageList()) {
                // The list also names what the network could craft or has on order; only what is there counts.
                if (s == null || s.getStackSize() <= 0) continue;
                ItemStack one = s.getItemStack();
                if (one == null || one.getItem() == null) continue;
                one.stackSize = 1;
                out.add(new Stored(one, s.getStackSize()));
            }
            Collections.sort(out, (a, b) -> Long.compare(b.count, a.count));
            return out;
        }

        static boolean isScreen(Container c) {
            return c instanceof appeng.container.implementations.ContainerMEMonitorable;
        }

        static boolean online(Container c) {
            appeng.container.implementations.ContainerMEMonitorable m = (appeng.container.implementations.ContainerMEMonitorable) c;
            if (m.getPowerSource() == null) return false;
            appeng.api.networking.IGridNode node = m.getNetworkNode();
            // A wireless terminal or a portable cell has no node of its own; its power source is what counts.
            return node == null || node.isActive();
        }

        static List<Stored> stored(Container c) {
            Object target = ((appeng.container.AEBaseContainer) c).getTarget();
            if (!(target instanceof appeng.api.storage.ITerminalHost)) return Collections.emptyList();
            return list(((appeng.api.storage.ITerminalHost) target).getItemInventory());
        }

        static void click(Container c, EntityPlayerMP p, ItemStack target, Click click) {
            appeng.container.implementations.ContainerMEMonitorable m = (appeng.container.implementations.ContainerMEMonitorable) c;
            // A client first names the entry under its cursor, then says how it clicked; the server does this with
            // the two messages.
            m.setTargetStack(target == null ? null : appeng.api.AEApi.instance()
                .storage()
                .createItemStack(target));
            appeng.helpers.MonitorableAction action;
            switch (click) {
                case TAKE_STACK:
                    action = appeng.helpers.MonitorableAction.SHIFT_CLICK;
                    break;
                case PICK_UP_OR_PUT_DOWN:
                    action = appeng.helpers.MonitorableAction.PICKUP_OR_SET_DOWN;
                    break;
                default:
                    action = appeng.helpers.MonitorableAction.SPLIT_OR_PLACE_SINGLE;
            }
            m.doMonitorableAction(action, 0, p);
            m.detectAndSendChanges();
        }
    }
}
