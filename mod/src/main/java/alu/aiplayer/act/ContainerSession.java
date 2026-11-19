package alu.aiplayer.act;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.IInventory;
import net.minecraft.inventory.ISidedInventory;
import net.minecraft.inventory.Slot;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;

/**
 * One visit to a container the bot is standing next to: open it, move stacks in or out one at a time, close it.
 * <p>
 * The normal way is the container's own screen, driven with the same clicks a player uses. On a GregTech
 * processing machine, ingredients are placed directly into its recipe input slots, not its utility slots.
 * Drawers have no screen and are punched to take, right-clicked with the item in hand to fill. Other storage
 * without a screen (barrels) is filled and emptied through its item-handling interface, the way a hopper would.
 * An Applied Energistics terminal is used through its screen too, but what its network stores is a list, not slots:
 * entries of the list are clicked as {@link MeNetworks} says.
 */
public final class ContainerSession {

    public enum Status {
        WORKING,
        DONE,
        FAILED
    }

    /** Which of the bot's stacks to put in, and how many items at most (-1 for all). */
    public interface DepositPlan {

        /** How many items of this stack should go in: 0 to keep it, -1 for the whole stack. */
        int wanted(ItemStack stack);

        void moved(ItemStack type, int count);

        /**
         * Whether everything of this kind the bot still carries ({@code carried} items) is to go in. Only then
         * may a drawer be double-clicked, which empties the whole inventory of that kind into it at once.
         */
        default boolean wholeKind(ItemStack type, int carried) {
            return false;
        }
    }

    private static final int CLICK_INTERVAL = 3;
    private static final int OPEN_WAIT = 4;
    /** Two right-clicks on a drawer within ten ticks count as a double click, which empties the whole inventory
     * of that kind into it. */
    private static final int DRAWER_PUT_INTERVAL = 12;
    private static final int DRAWER_DOUBLE_CLICK = 2;

    private final Bot bot;
    private final int x, y, z;
    private DepositPlan deposit;
    private List<ItemFilter> withdraw;
    private int[] withdrawLeft;
    private int phase; // 0 open, 1 wait for screen, 2 screen transfers, 3 direct transfers, 4 closing, 5 drawers,
                       // 6 an ME terminal's list
    private int interval = CLICK_INTERVAL;
    private final Set<ItemStack> unplaceable = Collections.newSetFromMap(new IdentityHashMap<ItemStack, Boolean>());
    private final Set<Integer> deadDrawers = new HashSet<>();
    /** Kinds an ME terminal listed but did not give (the network's security, or gone meanwhile). */
    private final Set<String> deadKinds = new HashSet<>();
    /** Set after a click put a stack into a drawer when the rest of that kind may follow with a second click. */
    private ItemStack dumpType;
    private float[] dumpHit;
    /** For a processing machine, its input and output slots as {first, count}. */
    private int[] machineIn, machineOut;
    private boolean fromInputs;
    private boolean returningIngredients;
    /** An alternate screen chosen by the caller, as opposed to a face chosen just to reach the machine. */
    private boolean explicitFace;
    private int wait;
    private int cursor;
    private boolean viaScreen;
    private int rejected;
    private boolean takeAll;

    public int moved;
    /** Actual kinds received, for callers reporting returns without inventing a variant from a wildcard filter. */
    public final alu.aiplayer.util.Kinds received = new alu.aiplayer.util.Kinds();
    /** True when some of what was to be deposited did not fit. */
    public boolean containerFull;
    /** True when a withdrawal stopped because the bot's inventory is full. */
    public boolean inventoryFull;
    /** No native whole/half pickup fits the requested remaining count. Nothing from that slot was taken. */
    public boolean pickupLimited;
    public int smallestPickup, wantedPickup;
    /** A drawer clicks the held stack, so a partial stack needs somewhere to put the surplus first. */
    public boolean splitSpaceRequired;
    /** True when the screen used was an ME terminal's: what was moved went into or came out of its network. */
    public boolean meNetwork;
    /** True when an ME terminal listed something wanted and a click on it gave nothing. */
    public boolean networkRefused;
    private boolean requireProcessingSlots;

    /** A bus-less controller may only be loaded through a real input/output screen, not a special-item slot. */
    public ContainerSession processingSlots() {
        requireProcessingSlots = true;
        return this;
    }

    /** Kept for existing callers; all output withdrawals now respect native pickup/count limits. */
    public ContainerSession boundedWithdrawal() {
        return this;
    }
    public String failCode;
    public String failMessage;
    /** With a refusal: the container's position, and what protects it when it was the server's own protection. */
    public com.google.gson.JsonObject failDetail;

    /** When set, the screen is the one a carried item opens when used (a backpack), not a block's. */
    private final ItemFilter opener;
    private int openerSlot = -1;

    public ContainerSession(Bot bot, int x, int y, int z) {
        this.bot = bot;
        this.x = x;
        this.y = y;
        this.z = z;
        this.opener = null;
    }

    /** A session at the screen that opens when the bot uses an item it carries: a backpack and its like. */
    public ContainerSession(Bot bot, ItemFilter opener) {
        this.bot = bot;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.opener = opener;
    }

    public ContainerSession deposit(DepositPlan plan) {
        this.deposit = plan;
        return this;
    }

    public ContainerSession withdraw(List<ItemFilter> items) {
        this.withdraw = items;
        this.withdrawLeft = new int[items.size()];
        for (int i = 0; i < items.size(); i++) {
            withdrawLeft[i] = items.get(i).count < 0 ? Integer.MAX_VALUE : items.get(i).count;
        }
        return this;
    }

    /** Takes everything the container holds, as far as the bot can carry it. */
    public ContainerSession withdrawAll() {
        this.withdraw = new ArrayList<>();
        this.withdrawLeft = new int[] { Integer.MAX_VALUE };
        this.takeAll = true;
        return this;
    }

    /** Items of each withdraw filter still not obtained (0 when satisfied or when everything available was taken). */
    public int withdrawMissing(int index) {
        return withdrawLeft[index] == Integer.MAX_VALUE ? 0 : withdrawLeft[index];
    }

    /** The face to click to open the screen (0 down .. 5 east), or -1 for the one turned towards the bot. */
    private int openSide = -1;
    private boolean openSneak;
    private boolean routedMachineClick;

    /**
     * Opens the screen with a click on a chosen face, sneaking or not, instead of a plain click: some blocks show
     * a different screen that way (a cover on a machine's face opens its own when the face is sneak-clicked).
     * Whatever screen that click opens is then used as any screen is.
     */
    public ContainerSession via(int side, boolean sneak) {
        openSide = side;
        openSneak = sneak;
        explicitFace = side >= 0 || sneak;
        return this;
    }

    private boolean viaFace() {
        return openSide >= 0 || openSneak;
    }

    /** At a processing machine, take from the input slots instead of the output slots: getting back what was put in. */
    public ContainerSession fromInputSlots() {
        fromInputs = true;
        return this;
    }

    /** A process refund may recover only from the recipe inputs counted before loading, not utility slots. */
    public ContainerSession returnIngredients() {
        returningIngredients = true;
        return fromInputSlots();
    }

    public boolean usedScreen() {
        return viaScreen;
    }

    public Status tick() {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (opener != null && phase <= 1) return openByItem(p);
        switch (phase) {
            case 0: {
                if (!w.blockExists(x, y, z)) return fail("out_of_reach", "the container is out of reach");
                TileEntity te = w.getTileEntity(x, y, z);
                float[] actualHit = null;
                if (!viaFace()) {
                    int faces = Machines.machineAccessFaces(te);
                    if (faces >= 0) {
                        // Re-read the covers and the ray at the actual click, after any walking.
                        net.minecraft.util.MovingObjectPosition hit = Sight.visibleFace(p, x, y, z, faces);
                        if (hit == null) return fail("out_of_reach", "no visible machine face can be clicked without operating a cover; nothing was clicked");
                        openSide = hit.sideHit;
                        actualHit = new float[] { (float) (hit.hitVec.xCoord - x), (float) (hit.hitVec.yCoord - y), (float) (hit.hitVec.zCoord - z) };
                        routedMachineClick = true;
                    } else {
                        int terminal = MeNetworks.terminalSide(te, p);
                        if (terminal >= 0) openSide = terminal;
                    }
                }
                if (viaFace()) {
                    // Whatever that click opens: nothing is assumed about the block.
                    if (!Reach.canReach(p, x, y, z)) return fail("out_of_reach", "the block is out of reach");
                    if (openSide >= 0 && !Drawers.inFront(p, x, y, z, openSide)) {
                        return fail("out_of_reach", "that face of the block cannot be reached from here");
                    }
                    if (p.openContainer != p.inventoryContainer) bot.conn()
                        .closeWindow();
                    int side = openSide >= 0 ? openSide : Reach.facingSide(p, x, y, z);
                    float[] at = actualHit == null ? middleOf(side) : actualHit;
                    Motion.face(p, x + at[0], y + at[1], z + at[2]);
                    boolean was = p.isSneaking();
                    if (openSneak || routedMachineClick) p.setSneaking(openSneak);
                    try {
                        clickEmptyHanded(bot, x, y, z, side, at[0], at[1], at[2]);
                    } finally {
                        if (openSneak || routedMachineClick) p.setSneaking(was);
                    }
                    phase = 1;
                    wait = 0;
                    return Status.WORKING;
                }
                if (!(te instanceof IInventory)) return fail("invalid", "there is no container at that position");
                if (!Reach.canReach(p, x, y, z)) return fail("out_of_reach", "the container is out of reach");
                // Some other screen left open would be mistaken for this container's.
                if (p.openContainer != p.inventoryContainer) bot.conn()
                    .closeWindow();
                if (Drawers.is(te)) {
                    if (!Drawers.inFront(p, x, y, z, Drawers.front(te))) {
                        return fail("out_of_reach", "the front of the drawer cannot be reached from here");
                    }
                    if (Drawers.isSealed(te)) return fail("denied", "the drawer is sealed");
                    phase = 5;
                    wait = interval;
                    return Status.WORKING;
                }
                Motion.face(p, x + 0.5, y + 0.5, z + 0.5);
                clickEmptyHanded(p);
                phase = 1;
                wait = 0;
                return Status.WORKING;
            }
            case 1:
                if (bot.clickWasRefused(x, y, z)) return refused("opening the container");
                if (p.openContainer != p.inventoryContainer) {
                    TileEntity te = w.getTileEntity(x, y, z);
                    if (MeNetworks.isTerminalScreen(p.openContainer)) {
                        if (takeAll) {
                            return fail("invalid", "that is an ME terminal: a whole network is not emptied through it; list the items to take");
                        }
                        if (!MeNetworks.screenOnline(p.openContainer)) {
                            return fail("denied", "the ME terminal is dark: its network has no power or no channel for it; nothing was moved");
                        }
                        viaScreen = true;
                        meNetwork = true;
                        phase = 6;
                    } else if (hasOwnSlots(p)) {
                        // The way a player uses anything: through the screen it opens. The screen itself says
                        // where things may go and what may be taken, so nothing has to be known about the block.
                        viaScreen = true;
                        phase = 2;
                    } else if (requireProcessingSlots || needsRecipeInputs(te)) {
                        return fail("invalid", "the machine did not expose clickable input/output slots; nothing was moved");
                    } else if (viaFace()) {
                        bot.conn()
                            .closeWindow();
                        return fail("invalid", "that click opened a screen that shows nothing of the bot's own, so nothing can be moved through it");
                    } else {
                        // A screen that shows nothing of the bot's own cannot be clicked through. For the kinds
                        // of block whose inner slots are known, reach into those instead.
                        machineIn = Machines.inputSlots(te);
                        machineOut = Machines.outputSlots(te);
                        bot.conn()
                            .closeWindow();
                        if (!(te instanceof IInventory)) return fail("invalid", "there is no container at that position");
                        phase = 3;
                    }
                    wait = 0;
                    cursor = 0;
                } else if (++wait >= OPEN_WAIT) {
                    // An explicit GT face may legitimately run a cover action without opening a screen.
                    // Never interpret that as permission to transfer from a different side of the host.
                    if (routedMachineClick || (viaFace() && Machines.isGregTech(te)))
                        return fail("invalid", "no inventory screen opened on the selected machine face; no stock was transferred");
                    if (requireProcessingSlots) return fail("invalid", "the controller opened no input/output screen; nothing was put in");
                    // No screen opened although nothing refused the click: storage without one (barrels, drawers).
                    TileEntity te = w.getTileEntity(x, y, z);
                    if (needsRecipeInputs(te)) return fail("invalid", "the machine opened no input screen; nothing was moved");
                    if (MeNetworks.isTerminalHost(te)) {
                        // The plain terminal opens for anyone; the crafting and pattern terminals only for players
                        // the network's security lets craft.
                        return fail("denied", "the ME terminal did not open: its network's security does not let this player use it");
                    }
                    if (!(te instanceof IInventory) || !((IInventory) te).isUseableByPlayer(p)) {
                        return fail("denied", "the container cannot be used from here");
                    }
                    phase = 3;
                    wait = 0;
                    cursor = 0;
                }
                return Status.WORKING;
            case 2:
                if (p.openContainer == p.inventoryContainer) {
                    return fail("denied", "the container closed while it was being used");
                }
                if (++wait < CLICK_INTERVAL) return Status.WORKING;
                wait = 0;
                if (!screenStep(p)) {
                    if (failCode != null) return fail(failCode, failMessage);
                    bot.conn()
                        .closeWindow();
                    phase = 4;
                }
                return Status.WORKING;
            case 3: {
                TileEntity te = w.getTileEntity(x, y, z);
                if (!(te instanceof IInventory)) return fail("invalid", "the container is gone");
                if (++wait < CLICK_INTERVAL) return Status.WORKING;
                wait = 0;
                if (!directStep(p, (IInventory) te)) phase = 4;
                return Status.WORKING;
            }
            case 6:
                // The server closes a terminal's screen itself when its network changes under it.
                if (!MeNetworks.isTerminalScreen(p.openContainer)) {
                    return fail("denied", "the ME terminal closed while it was being used");
                }
                if (++wait < CLICK_INTERVAL) return Status.WORKING;
                wait = 0;
                if (!meStep(p)) {
                    if (failCode != null) return fail(failCode, failMessage);
                    bot.conn()
                        .closeWindow();
                    phase = 4;
                }
                return Status.WORKING;
            case 5: {
                TileEntity te = w.getTileEntity(x, y, z);
                if (!Drawers.is(te)) return fail("invalid", "the container is gone");
                if (bot.clickWasRefused(x, y, z) || bot.punchWasRefused(x, y, z)) return refused("using the drawer");
                if (++wait < interval) return Status.WORKING;
                wait = 0;
                if (!drawerStep(p, te)) phase = 4;
                return Status.WORKING;
            }
            default:
                if (++wait >= 2) {
                    keep();
                    return Status.DONE;
                }
                return Status.WORKING;
        }
    }

    /**
     * Has the world save what was changed at this block. A block is saved only when something marks it as changed,
     * and not everything that holds items does so itself (the item-holder cover on a GregTech machine does not):
     * what was put there would then be gone after a restart, while the bot's inventory was saved without it.
     */
    private void keep() {
        if (opener == null && bot.online()) markChanged(bot.player().worldObj, x, y, z);
    }

    public static void markChanged(World w, int x, int y, int z) {
        try {
            if (!w.blockExists(x, y, z)) return;
            TileEntity te = w.getTileEntity(x, y, z);
            if (te != null) te.markDirty();
            w.getChunkFromBlockCoords(x, z)
                .setChunkModified();
        } catch (Throwable ignored) {}
    }

    // ---- drawers ------------------------------------------------------------------------------------------------

    /** Does one click on the drawer block. Returns false when there is nothing left to do. */
    private boolean drawerStep(EntityPlayerMP p, TileEntity te) {
        List<Drawers.Slot> slots = Drawers.slots(te);
        int front = Drawers.front(te);
        if (deposit != null) {
            ItemStack[] mine = p.inventory.mainInventory;
            if (dumpType != null) {
                // The second click of a double click: the drawer takes everything of that kind the bot carries.
                ItemStack type = dumpType;
                float[] hit = dumpHit;
                dumpType = null;
                ItemFilter kind = exact(type);
                int before = Inventories.count(p, kind);
                int slot = -1;
                for (int i = 0; i < mine.length && slot < 0; i++) if (mine[i] != null && kind.matches(mine[i])) slot = i;
                if (slot >= 0) {
                    Inventories.hold(bot, slot);
                    Motion.face(p, x + hit[0], y + hit[1], z + hit[2]);
                    bot.conn()
                        .useOnBlock(x, y, z, front, hit[0], hit[1], hit[2]);
                    bot.conn()
                        .swingArm();
                    int gone = before - Inventories.count(p, kind);
                    if (gone > 0) {
                        moved += gone;
                        deposit.moved(type, gone);
                    }
                    // What did not fit is found, stack by stack, by the steps that follow.
                    interval = DRAWER_PUT_INTERVAL;
                    return true;
                }
            }
            for (int i = 0; i < mine.length; i++) {
                ItemStack stack = mine[i];
                if (stack == null || unplaceable.contains(stack)) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                // A drawer already holding this kind comes first; an unassigned one only when none does.
                Drawers.Slot target = null;
                for (Drawers.Slot s : slots) {
                    if (s.prototype != null && s.room > 0 && sameItem(s.prototype, stack)) {
                        target = s;
                        break;
                    }
                }
                if (target == null) {
                    for (Drawers.Slot s : slots) {
                        if (s.prototype == null && Drawers.accepts(te, s.index, stack)) {
                            target = s;
                            break;
                        }
                    }
                }
                float[] hit = target == null ? null : Drawers.hit(te, target.index);
                if (hit == null) {
                    unplaceable.add(stack);
                    rejected++;
                    continue;
                }
                // The click puts in the whole held stack, so the part to keep is set aside first.
                if (want > 0 && want < stack.stackSize && !splitOff(p, i, stack.stackSize - want)) {
                    inventoryFull = true;
                    splitSpaceRequired = true;
                    unplaceable.add(stack);
                    continue;
                }
                ItemStack type = stack.copy();
                int offered = stack.stackSize;
                int before = Inventories.count(p, exact(type));
                Inventories.hold(bot, i);
                Motion.face(p, x + hit[0], y + hit[1], z + hit[2]);
                bot.conn()
                    .useOnBlock(x, y, z, front, hit[0], hit[1], hit[2]);
                bot.conn()
                    .swingArm();
                int gone = before - Inventories.count(p, exact(type));
                if (gone > 0) {
                    moved += gone;
                    deposit.moved(type, gone);
                }
                if (gone < offered) {
                    rejected++;
                    ItemStack left = p.inventory.getCurrentItem();
                    if (left != null) unplaceable.add(left);
                }
                interval = DRAWER_PUT_INTERVAL;
                int still = Inventories.count(p, exact(type));
                if (gone == offered && still > 0 && deposit.wholeKind(type, still)) {
                    // As a player does with many stacks of one thing: click again at once and all of it goes in.
                    dumpType = type;
                    dumpHit = hit;
                    interval = DRAWER_DOUBLE_CLICK;
                }
                return true;
            }
            deposit = null;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            for (Drawers.Slot s : slots) {
                if (s.prototype == null || s.count <= 0 || deadDrawers.contains(s.index)) continue;
                int f = matchingFilter(s.prototype);
                if (f < 0) continue;
                int room = roomFor(p, s.prototype);
                if (room <= 0) {
                    inventoryFull = true;
                    break;
                }
                float[] hit = Drawers.hit(te, s.index);
                if (hit == null) {
                    deadDrawers.add(s.index);
                    continue;
                }
                // A punch gives a whole stack or a single item, nothing in between.
                int stack = Math.min(s.prototype.getMaxStackSize(), s.count);
                boolean whole = Math.min(withdrawLeft[f], room) >= stack;
                ItemFilter kind = exact(s.prototype);
                int had = Inventories.count(p, kind);
                Motion.face(p, x + hit[0], y + hit[1], z + hit[2]);
                Drawers.punch(te, p, hit, whole);
                bot.conn()
                    .swingArm();
                int got = Inventories.count(p, kind) - had;
                interval = CLICK_INTERVAL;
                if (got <= 0) {
                    // Locked, protected, or otherwise not giving: leave this drawer be.
                    deadDrawers.add(s.index);
                    return true;
                }
                moved += got;
                received.add(s.prototype, got);
                if (withdrawLeft[f] != Integer.MAX_VALUE) withdrawLeft[f] = Math.max(0, withdrawLeft[f] - got);
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /**
     * Right-clicks the container as if nothing were held. What is in hand is set aside for the duration of the
     * click and put straight back, so a held block is not placed and a held tool does not act on the container,
     * and it works with a full inventory too.
     */
    private void clickEmptyHanded(EntityPlayerMP p) {
        clickEmptyHanded(bot, x, y, z);
    }

    /** Takes the item in hand and uses it, as a player right-clicks a backpack, then waits for its screen. */
    private Status openByItem(EntityPlayerMP p) {
        if (phase == 0) {
            if (p.openContainer != p.inventoryContainer) bot.conn()
                .closeWindow();
            int slot = -1;
            for (int i = 0; i < Inventories.CARRY_SLOTS && slot < 0; i++) {
                ItemStack s = p.inventory.mainInventory[i];
                if (s != null && opener.matches(s)) slot = i;
            }
            if (slot < 0) return fail("no_material", "the bot carries no such item to open");
            Inventories.hold(bot, slot);
            openerSlot = p.inventory.currentItem;
            bot.conn()
                .useItem();
            phase = 1;
            wait = 0;
            return Status.WORKING;
        }
        if (p.openContainer != p.inventoryContainer) {
            if (MeNetworks.isTerminalScreen(p.openContainer)) {
                // A wireless terminal: the same list as a terminal on a cable shows.
                if (takeAll) return fail("invalid", "that is an ME terminal: a whole network is not emptied through it; list the items to take");
                if (!MeNetworks.screenOnline(p.openContainer)) {
                    return fail("denied", "the wireless terminal shows no network: out of range of an access point, or out of power; nothing was moved");
                }
                viaScreen = true;
                meNetwork = true;
                phase = 6;
                wait = 0;
                cursor = 0;
                return Status.WORKING;
            }
            if (!hasOwnSlots(p)) {
                bot.conn()
                    .closeWindow();
                return fail("invalid", "the screen that item opens is not one whose slots can be used");
            }
            viaScreen = true;
            phase = 2;
            wait = 0;
            cursor = 0;
        } else if (++wait >= OPEN_WAIT) {
            return fail("invalid", "using that item opened no screen; it may be something to place or to wear instead");
        }
        return Status.WORKING;
    }

    /** Right-clicks a block as if nothing were held; see the instance method. */
    /** The middle of a face, as a point within the block. */
    public static float[] middleOf(int side) {
        switch (side) {
            case 0:
                return new float[] { 0.5F, 0F, 0.5F };
            case 1:
                return new float[] { 0.5F, 1F, 0.5F };
            case 2:
                return new float[] { 0.5F, 0.5F, 0F };
            case 3:
                return new float[] { 0.5F, 0.5F, 1F };
            case 4:
                return new float[] { 0F, 0.5F, 0.5F };
            default:
                return new float[] { 1F, 0.5F, 0.5F };
        }
    }

    public static void clickEmptyHanded(Bot bot, int x, int y, int z) {
        clickEmptyHanded(bot, x, y, z, Reach.facingSide(bot.player(), x, y, z), 0.5F, 0.5F, 0.5F);
    }

    /** A right-click with nothing in hand on one face of a block, at a point of it. */
    public static void clickEmptyHanded(Bot bot, int x, int y, int z, int side, float hx, float hy, float hz) {
        EntityPlayerMP p = bot.player();
        int slot = p.inventory.currentItem;
        ItemStack held = p.inventory.mainInventory[slot];
        p.inventory.mainInventory[slot] = null;
        try {
            bot.conn()
                .useOnBlock(x, y, z, side, hx, hy, hz);
        } finally {
            if (p.inventory.mainInventory[slot] == null) {
                p.inventory.mainInventory[slot] = held;
            } else if (held != null && !p.inventory.addItemStackToInventory(held)) {
                // Something appeared in the hand during the click and there is no room: drop rather than lose it.
                p.dropPlayerItemWithRandomChoice(held, false);
            }
        }
        bot.conn()
            .swingArm();
    }

    /** Whether the open screen shows the bot's own inventory, so that things can be moved by clicking. */
    private static boolean hasOwnSlots(EntityPlayerMP p) {
        for (Object o : p.openContainer.inventorySlots) if (isOwn(p, (Slot) o)) return true;
        return false;
    }

    /**
     * Whether a slot of the open screen is one of the bot's own inventory. Plain screens say so directly. Screens
     * of other interface libraries (GregTech's among them) wrap the inventory in something of their own; there the
     * stack in the slot is still the very stack the bot carries, and an empty one names its wrapper.
     */
    private static boolean isOwn(EntityPlayerMP p, Slot s) {
        if (s.inventory == p.inventory) return true;
        ItemStack shown = s.getStack();
        if (shown != null) {
            for (ItemStack mine : p.inventory.mainInventory) if (mine == shown) return true;
            for (ItemStack worn : p.inventory.armorInventory) if (worn == shown) return true;
            return false;
        }
        return wrapsPlayer(s);
    }

    private static final java.util.Map<Class<?>, java.lang.reflect.Method> HANDLER_OF = new java.util.HashMap<>();

    private static boolean wrapsPlayer(Slot s) {
        try {
            Class<?> c = s.getClass();
            java.lang.reflect.Method m;
            synchronized (HANDLER_OF) {
                if (!HANDLER_OF.containsKey(c)) {
                    java.lang.reflect.Method found = null;
                    try {
                        found = c.getMethod("getItemHandler");
                    } catch (NoSuchMethodException none) {
                        // a slot of the ordinary kind
                    }
                    HANDLER_OF.put(c, found);
                }
                m = HANDLER_OF.get(c);
            }
            if (m == null) return false;
            Object handler = m.invoke(s);
            return handler != null && handler.getClass()
                .getSimpleName()
                .startsWith("Player");
        } catch (Throwable t) {
            return false;
        }
    }

    /** Ghost slots (a programmed-circuit setting) show an item that is not really there. */
    private static boolean isGhost(Slot s) {
        ItemStack shown = s.getStack();
        if (shown != null && shown.stackSize <= 0) return true;
        try {
            java.lang.reflect.Method m = s.getClass()
                .getMethod("isPhantom");
            return (Boolean) m.invoke(s);
        } catch (Throwable t) {
            return false;
        }
    }

    /** A slot nothing can be put into: where a machine lays its products. */
    private static boolean takesNothing(Slot s, ItemStack probe) {
        try {
            return !s.isItemValid(probe);
        } catch (Throwable t) {
            return false;
        }
    }

    public static boolean isOwnSlot(EntityPlayerMP p, Slot s) {
        return isOwn(p, s);
    }

    public static boolean isGhostSlot(Slot s) {
        return isGhost(s);
    }

    public static boolean slotTakesNothing(Slot s, ItemStack probe) {
        return takesNothing(s, probe);
    }

    /** An actual output declaration, not a restricted slot refusing one arbitrary probe item. */
    private static boolean isOutput(Slot s) {
        if (s instanceof net.minecraft.inventory.SlotCrafting || s instanceof net.minecraft.inventory.SlotFurnace
            || s instanceof net.minecraft.inventory.SlotMerchantResult) return true;
        try {
            return !(Boolean) s.getClass().getMethod("isCanPut").invoke(s);
        } catch (Throwable ignored) {}
        try {
            // IC2's SlotInvSlot wraps its native inventory slot, which explicitly declares input/output access.
            Object inv = s.getClass().getField("invSlot").get(s);
            return !(Boolean) inv.getClass().getMethod("canInput").invoke(inv)
                && (Boolean) inv.getClass().getMethod("canOutput").invoke(inv);
        } catch (Throwable ignored) {}
        // A filled storage/filter slot accepts its own item. Empty restricted slots say nothing about outputs.
        return s.getStack() != null && takesNothing(s, s.getStack());
    }

    /** A positive acceptance proves this is not an output-only slot. Failure to find an example is unknown. */
    private static boolean acceptsExample(Slot slot, Container c) {
        try {
            if (slot.isItemValid(new ItemStack(net.minecraft.init.Blocks.cobblestone))) return true;
        } catch (Throwable ignored) {}
        for (Object o : c.inventorySlots) {
            ItemStack s = ((Slot) o).getStack();
            if (s == null) continue;
            try { if (slot.isItemValid(s.copy())) return true; } catch (Throwable ignored) {}
        }
        return false;
    }

    /** Where in the bot's inventory the stack a slot shows is; -1 if it is not there. */
    private static int ownIndex(EntityPlayerMP p, Slot s) {
        ItemStack shown = s.getStack();
        if (shown == null) return -1;
        ItemStack[] inv = p.inventory.mainInventory;
        for (int i = 0; i < inv.length; i++) if (inv[i] == shown) return i;
        return -1;
    }

    public void abort() {
        if (bot.online() && bot.player().openContainer != bot.player().inventoryContainer) bot.conn()
            .closeWindow();
        keep();
    }

    private Status fail(String code, String message) {
        failCode = code;
        failMessage = message;
        abort();
        return Status.FAILED;
    }

    /** The bot's hand on the container was refused: says what refused it, and where. */
    private Status refused(String what) {
        Status st = fail("denied", bot.refused(what));
        failDetail = bot.refusalDetail(x, y, z);
        return st;
    }

    // ---- through the container's screen -----------------------------------------------------------------------

    private boolean needsRecipeInputs(TileEntity te) {
        return (deposit != null || returningIngredients) && Machines.isProcessor(te);
    }

    /** Null for an ordinary transfer. An empty list on a recipe screen means no eligible input, not free choice. */
    private List<Slot> recipeInputs(EntityPlayerMP p, List<Slot> theirs) {
        if (opener != null) return null;
        TileEntity te = p.worldObj.getTileEntity(x, y, z);
        if (!needsRecipeInputs(te)) return null;
        List<Slot> inputs = new ArrayList<>();
        boolean machineScreen = false;
        for (Slot slot : theirs) {
            if (!Machines.ownSlot(te, slot)) continue;
            machineScreen = true;
            if ("input".equals(Machines.slotRole(te, slot.getSlotIndex()))) inputs.add(slot);
        }
        // A cover opened on an explicit face owns its slots. Its indices do not describe the host's inventory.
        return explicitFace && !machineScreen ? null : inputs;
    }

    /** Does one transfer. Returns false when there is nothing left to do. */
    private boolean screenStep(EntityPlayerMP p) {
        Container c = p.openContainer;
        List<Slot> mine = new ArrayList<>();
        List<Slot> theirs = new ArrayList<>();
        // Only an output declaration (or a filled slot refusing its own contents) identifies products.
        // Empty pattern/fuel/tool slots refusing cobblestone do not turn storage into a processing machine.
        boolean hasProductSlots = false;
        for (Object o : c.inventorySlots) {
            Slot s = (Slot) o;
            if (isOwn(p, s)) {
                if (ownIndex(p, s) >= 0 || s.getStack() == null) mine.add(s);
                continue;
            }
            if (isGhost(s)) continue;
            theirs.add(s);
            if (opener == null && isOutput(s)) hasProductSlots = true;
        }
        List<Slot> inputs = recipeInputs(p, theirs);
        if (!hasProductSlots && opener == null && withdraw != null && !fromInputs) {
            List<Integer> unknown = new ArrayList<>();
            for (Slot s : theirs) if (s.getStack() == null && !acceptsExample(s, c)) unknown.add(s.slotNumber);
            if (!unknown.isEmpty()) {
                failCode = "invalid";
                failMessage = "cannot distinguish empty restricted slots from output slots " + unknown
                    + "; no default withdrawal was made, to preserve pending inputs. Use the screen to select a slot"
                    + " or fromInputs only when intentionally taking inputs";
                return false;
            }
        }
        if (requireProcessingSlots && (!hasProductSlots || theirs.stream().noneMatch(s -> !isOutput(s)))) {
            failCode = "invalid";
            failMessage = "the controller screen has no usable input/output slots; nothing was put in";
            return false;
        }
        if (deposit != null) {
            for (; cursor < mine.size(); cursor++) {
                Slot s = mine.get(cursor);
                ItemStack stack = s.getStack();
                if (stack == null) continue;
                int index = ownIndex(p, s);
                if (index < 0 || index >= Inventories.CARRY_SLOTS) continue;
                // The bag in the hand does not go into itself.
                if (opener != null && index == openerSlot) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                ItemStack type = stack.copy();
                int offered = want < 0 ? stack.stackSize : Math.min(want, stack.stackSize);
                // Counted across the whole inventory: some screens answer a shift-click by shuffling the stack
                // to another of the bot's own slots, which is not a deposit.
                int before = Inventories.count(p, exact(type));
                if (inputs != null || offered < stack.stackSize) {
                    // Even a whole-stack shift lets the screen choose the destination. When the task targets
                    // recipe inputs, click those slots instead, returning anything they did not take.
                    if (p.inventory.getItemStack() != null) {
                        failCode = "invalid";
                        failMessage = "the cursor already holds an item; clear it before transferring";
                        return false;
                    }
                    c.slotClick(s.slotNumber, 0, 0, p);
                    placeCount(p, c, inputs != null ? inputs : theirs, offered);
                    if (p.inventory.getItemStack() != null) c.slotClick(s.slotNumber, 0, 0, p);
                } else c.slotClick(s.slotNumber, 0, 1, p);
                c.detectAndSendChanges();
                int gone = before - Inventories.count(p, exact(type));
                if (gone > 0) {
                    moved += gone;
                    deposit.moved(type, gone);
                }
                // What stays behind did not fit. Other kinds of item might still, so carry on.
                if (gone < offered) rejected++;
                cursor++;
                return true;
            }
            deposit = null;
            cursor = 0;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            boolean recipeRefund = returningIngredients && inputs != null;
            List<Slot> sources = recipeRefund ? inputs : theirs;
            for (; cursor < sources.size(); cursor++) {
                Slot s = sources.get(cursor);
                ItemStack stack = s.getStack();
                if (stack == null || !s.canTakeStack(p)) continue;
                if (!recipeRefund && hasProductSlots && isOutput(s) == fromInputs) continue;
                int f = matchingFilter(stack);
                if (f < 0) continue;
                ItemStack type = stack.copy();
                int had = Inventories.count(p, exact(type));
                int room = roomFor(p, stack);
                int want = Math.min(withdrawLeft[f], Math.min(room, stack.stackSize));
                if (want <= 0) {
                    inventoryFull = true;
                    break;
                }
                if (p.inventory.getItemStack() != null) {
                    failCode = "invalid";
                    failMessage = "the cursor already holds an item; clear it before transferring";
                    return false;
                }
                boolean returnable = s.isItemValid(stack) && !isOutput(s);
                if (!returnable && want < stack.stackSize) {
                    int half = (stack.stackSize + 1) / 2;
                    if (half > want) {
                        if (room < Math.min(half, withdrawLeft[f])) inventoryFull = true;
                        else {
                            pickupLimited = true;
                            smallestPickup = half;
                            wantedPickup = withdrawLeft[f];
                        }
                        continue;
                    }
                    // Output slots cannot take a surplus back. Only a native whole/half pickup within the
                    // requested count is safe; never return product surplus into a machine's input slots.
                    c.slotClick(s.slotNumber, 1, 0, p);
                    placeCount(p, c, mine, half);
                } else {
                    c.slotClick(s.slotNumber, 0, 0, p);
                    placeCount(p, c, mine, want);
                    if (p.inventory.getItemStack() != null && returnable) c.slotClick(s.slotNumber, 0, 0, p);
                }
                c.detectAndSendChanges();
                int got = Inventories.count(p, exact(type)) - had;
                if (got <= 0) {
                    inventoryFull = Inventories.freeSlots(p) == 0;
                    if (inventoryFull) break;
                    continue;
                }
                moved += got;
                received.add(type, got);
                if (withdrawLeft[f] != Integer.MAX_VALUE) withdrawLeft[f] = Math.max(0, withdrawLeft[f] - got);
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /** Place at most count cursor items through real clicks, matching stacks before empty slots. */
    private static void placeCount(EntityPlayerMP p, Container c, List<Slot> slots, int count) {
        for (int pass = 0; pass < 2 && count > 0; pass++) for (Slot target : slots) {
            ItemStack hand = p.inventory.getItemStack();
            if (hand == null || count <= 0) return;
            ItemStack there = target.getStack();
            if (pass == 0 ? there == null : there != null) continue;
            if (!target.isItemValid(hand) || (there != null && !sameItem(there, hand))) continue;
            while (count > 0 && (hand = p.inventory.getItemStack()) != null) {
                int before = hand.stackSize;
                // A left click is safe only when the entire cursor is wanted. Otherwise right-click one.
                c.slotClick(target.slotNumber, before <= count ? 0 : 1, 0, p);
                ItemStack after = p.inventory.getItemStack();
                int placed = before - (after == null ? 0 : after.stackSize);
                if (placed <= 0) break;
                count -= placed;
            }
        }
    }

    private static boolean splitOff(EntityPlayerMP p, int invSlot, int count) {
        if (p.inventory.getItemStack() != null) return false;
        Container c = p.openContainer;
        Slot source = null, spare = null;
        for (Object o : c.inventorySlots) {
            Slot s = (Slot) o;
            if (s.inventory != p.inventory || s.getSlotIndex() >= Inventories.CARRY_SLOTS) continue;
            if (s.getSlotIndex() == invSlot) source = s;
            else if (s.getStack() == null) spare = s;
        }
        if (source == null || spare == null || source.getStack() == null) return false;
        c.slotClick(source.slotNumber, 0, 0, p);
        placeCount(p, c, Collections.singletonList(spare), count);
        if (p.inventory.getItemStack() != null) c.slotClick(source.slotNumber, 0, 0, p);
        c.detectAndSendChanges();
        return spare.getStack() != null && spare.getStack().stackSize == count;
    }

    private int matchingFilter(ItemStack stack) {
        if (withdraw.isEmpty()) return takeAll ? 0 : -1;
        for (int i = 0; i < withdraw.size(); i++) {
            if (withdrawLeft[i] > 0 && withdraw.get(i)
                .matches(stack)) return i;
        }
        return -1;
    }

    private static ItemFilter exact(ItemStack type) {
        return new ItemFilter(alu.aiplayer.util.Names.itemId(type.getItem()), alu.aiplayer.util.Names.meta(type), -1);
    }

    private static boolean sameItem(ItemStack a, ItemStack b) {
        return a != null && b != null
            && a.getItem() == b.getItem()
            && a.getItemDamage() == b.getItemDamage()
            && ItemStack.areItemStackTagsEqual(a, b);
    }

    // ---- through an ME terminal ----------------------------------------------------------------------------------

    /**
     * Does one transfer at an open terminal. Returns false when there is nothing left to do.
     * <p>
     * Putting in: a shift-click on one of the bot's own stacks stores all of it; for part of a stack the stack is
     * picked up, the part to keep is put back and the rest is put down on the list. Taking: a shift-click on an
     * entry gives a stack; for less than a stack one is picked up, the wanted number is placed in the bot's slots
     * and the rest is put back down on the list. The counts are exact either way.
     */
    private boolean meStep(EntityPlayerMP p) {
        Container c = p.openContainer;
        List<Slot> mine = new ArrayList<>();
        for (Object o : c.inventorySlots) {
            Slot s = (Slot) o;
            if (!isOwn(p, s)) continue;
            int index = s.getStack() == null ? s.getSlotIndex() : ownIndex(p, s);
            if (index >= 0 && index < Inventories.CARRY_SLOTS) mine.add(s);
        }
        if (p.inventory.getItemStack() != null) {
            failCode = "invalid";
            failMessage = "the cursor already holds an item; clear it before transferring";
            return false;
        }
        if (deposit != null) {
            for (; cursor < mine.size(); cursor++) {
                Slot s = mine.get(cursor);
                ItemStack stack = s.getStack();
                if (stack == null) continue;
                int index = ownIndex(p, s);
                if (index < 0) continue;
                // The wireless terminal in the hand does not go into its own network.
                if (opener != null && index == openerSlot) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                ItemStack type = stack.copy();
                int offered = want < 0 ? stack.stackSize : Math.min(want, stack.stackSize);
                int before = Inventories.count(p, exact(type));
                if (offered >= stack.stackSize) {
                    c.slotClick(s.slotNumber, 0, 1, p);
                } else {
                    int keep = stack.stackSize - offered;
                    c.slotClick(s.slotNumber, 0, 0, p);
                    if (keep <= offered) {
                        // Right-clicks put the part to keep back one at a time; the rest goes down on the list.
                        for (int i = 0; i < keep && p.inventory.getItemStack() != null; i++) c.slotClick(s.slotNumber, 1, 0, p);
                        MeNetworks.click(c, p, null, MeNetworks.Click.PICK_UP_OR_PUT_DOWN);
                    } else {
                        // Right-clicks on the list put the wanted number in one at a time.
                        for (int i = 0; i < offered; i++) {
                            ItemStack hand = p.inventory.getItemStack();
                            if (hand == null) break;
                            int held = hand.stackSize;
                            MeNetworks.click(c, p, null, MeNetworks.Click.SPLIT_OR_PUT_ONE);
                            ItemStack after = p.inventory.getItemStack();
                            if (after != null && after.stackSize >= held) break;
                        }
                    }
                    // What is still on the cursor is the part to keep, or what the network had no room for.
                    if (p.inventory.getItemStack() != null) c.slotClick(s.slotNumber, 0, 0, p);
                    emptyCursor(p, c, mine);
                }
                c.detectAndSendChanges();
                int gone = before - Inventories.count(p, exact(type));
                if (gone > 0) {
                    moved += gone;
                    deposit.moved(type, gone);
                }
                // What stays behind did not fit. Other kinds of item might still, so carry on.
                if (gone < offered) rejected++;
                cursor++;
                return true;
            }
            deposit = null;
            cursor = 0;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            for (MeNetworks.Stored kind : MeNetworks.stored(c)) {
                String key = alu.aiplayer.util.Kinds.key(kind.prototype) + (kind.prototype.hasTagCompound() ? "#" + kind.prototype.getTagCompound()
                    .hashCode() : "");
                if (deadKinds.contains(key)) continue;
                int f = matchingFilter(kind.prototype);
                if (f < 0) continue;
                ItemStack type = kind.prototype.copy();
                int room = roomFor(p, type);
                int want = (int) Math.min(withdrawLeft[f], Math.min((long) room, kind.count));
                if (want <= 0) {
                    inventoryFull = true;
                    break;
                }
                int had = Inventories.count(p, exact(type));
                // One click gives a stack, or all there is when that is less.
                int stack = (int) Math.min(type.getMaxStackSize(), kind.count);
                if (want >= stack) {
                    MeNetworks.click(c, p, type, MeNetworks.Click.TAKE_STACK);
                } else {
                    MeNetworks.click(c, p, type, MeNetworks.Click.PICK_UP_OR_PUT_DOWN);
                    placeCount(p, c, mine, want);
                    if (p.inventory.getItemStack() != null) MeNetworks.click(c, p, null, MeNetworks.Click.PICK_UP_OR_PUT_DOWN);
                    emptyCursor(p, c, mine);
                }
                c.detectAndSendChanges();
                int got = Inventories.count(p, exact(type)) - had;
                if (got <= 0) {
                    // Listed but not given: the network's security lets this player look and not take, or it went
                    // elsewhere meanwhile. Leave this kind be.
                    deadKinds.add(key);
                    networkRefused = true;
                    continue;
                }
                moved += got;
                received.add(type, got);
                if (withdrawLeft[f] != Integer.MAX_VALUE) withdrawLeft[f] = Math.max(0, withdrawLeft[f] - got);
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /**
     * Never leaves a stack on the cursor when a screen is about to close (it would be thrown on the ground): what a
     * network would not take back goes into the bot's own slots, and on the ground only when those are full too.
     */
    private static void emptyCursor(EntityPlayerMP p, Container c, List<Slot> mine) {
        ItemStack hand = p.inventory.getItemStack();
        if (hand == null) return;
        placeCount(p, c, mine, hand.stackSize);
        hand = p.inventory.getItemStack();
        if (hand == null) return;
        p.inventory.setItemStack(null);
        p.dropPlayerItemWithRandomChoice(hand, false);
    }

    // ---- through the item-handling interface ------------------------------------------------------------------

    private boolean directStep(EntityPlayerMP p, IInventory inv) {
        ItemStack[] mine = p.inventory.mainInventory;
        if (deposit != null) {
            for (; cursor < mine.length; cursor++) {
                ItemStack stack = mine[cursor];
                if (stack == null) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                if (want < 0 || want > stack.stackSize) want = stack.stackSize;
                ItemStack type = stack.copy();
                int put = insert(inv, stack, want);
                if (put < want) rejected++;
                if (stack.stackSize <= 0) mine[cursor] = null;
                if (put > 0) {
                    moved += put;
                    deposit.moved(type, put);
                    inv.markDirty();
                    p.inventory.markDirty();
                }
                cursor++;
                return true;
            }
            deposit = null;
            cursor = 0;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            int[] slots = slotsFor(inv, false);
            for (; cursor < slots.length; cursor++) {
                int slot = slots[cursor];
                ItemStack stack = inv.getStackInSlot(slot);
                if (stack == null) continue;
                int f = matchingFilter(stack);
                if (f < 0) continue;
                if (machineIn == null && inv instanceof ISidedInventory
                    && !((ISidedInventory) inv).canExtractItem(slot, stack, 1)) continue;
                int room = roomFor(p, stack);
                if (room <= 0) {
                    inventoryFull = true;
                    break;
                }
                int take = Math.min(room, Math.min(stack.stackSize, withdrawLeft[f]));
                ItemStack type = stack.copy();
                ItemStack out = inv.decrStackSize(slot, take);
                if (out == null) continue;
                int got = out.stackSize;
                if (!p.inventory.addItemStackToInventory(out) && out.stackSize > 0) {
                    // Should not happen after the room check; never let the remainder vanish.
                    got -= out.stackSize;
                    p.dropPlayerItemWithRandomChoice(out, false);
                }
                inv.markDirty();
                p.inventory.markDirty();
                if (got > 0) {
                    moved += got;
                    received.add(type, got);
                    if (withdrawLeft[f] != Integer.MAX_VALUE) withdrawLeft[f] -= got;
                    // Deep storage (barrels and the like) shows one stack at a time in its output slot and fills it
                    // again from what it holds: keep taking from the same slot while it does.
                    ItemStack again = inv.getStackInSlot(slot);
                    if (withdrawLeft[f] > 0 && again != null && again.stackSize > 0 && sameItem(again, type)) return true;
                }
                cursor++;
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /** How many more items like this the bot's inventory can take. */
    private static int roomFor(EntityPlayerMP p, ItemStack like) {
        int room = 0;
        int max = like.getMaxStackSize();
        ItemStack[] inv = p.inventory.mainInventory;
        for (int i = 0; i < inv.length && i < Inventories.CARRY_SLOTS; i++) {
            ItemStack s = inv[i];
            if (s == null) room += max;
            else if (sameItem(s, like) && s.isStackable()) room += Math.max(0, max - s.stackSize);
        }
        return room;
    }

    private int[] slotsFor(IInventory inv, boolean putting) {
        if (machineIn == null || machineOut == null) return accessible(inv);
        int[] range = putting || fromInputs ? machineIn : machineOut;
        int[] out = new int[Math.max(0, Math.min(range[1], inv.getSizeInventory() - range[0]))];
        for (int i = 0; i < out.length; i++) out[i] = range[0] + i;
        return out;
    }

    private static int[] accessible(IInventory inv) {
        if (inv instanceof ISidedInventory) {
            int[] slots = ((ISidedInventory) inv).getAccessibleSlotsFromSide(1);
            if (slots != null) return slots;
        }
        int[] all = new int[inv.getSizeInventory()];
        for (int i = 0; i < all.length; i++) all[i] = i;
        return all;
    }

    /** Moves up to {@code count} items of a stack into the inventory, hopper-style. Returns how many went in. */
    private int insert(IInventory inv, ItemStack stack, int count) {
        int left = count;
        int[] slots = slotsFor(inv, true);
        boolean machine = machineIn != null;
        int limit = inv.getInventoryStackLimit();
        // Top up matching stacks before opening new slots.
        for (int pass = 0; pass < 2 && left > 0; pass++) {
            for (int slot : slots) {
                if (left <= 0) break;
                ItemStack there = inv.getStackInSlot(slot);
                if (pass == 0 ? there == null : there != null) continue;
                // A machine's sides matter to pipes and hoppers, not to a hand reaching into its screen.
                if (!machine && !inv.isItemValidForSlot(slot, stack)) continue;
                if (!machine && inv instanceof ISidedInventory
                    && !((ISidedInventory) inv).canInsertItem(slot, stack, 1)) continue;
                if (there == null) {
                    int n = Math.min(left, Math.min(limit, stack.getMaxStackSize()));
                    inv.setInventorySlotContents(slot, stack.splitStack(n));
                    left -= n;
                } else if (sameItem(there, stack)) {
                    int room = Math.min(limit, there.getMaxStackSize()) - there.stackSize;
                    int n = Math.min(left, room);
                    if (n > 0) {
                        there.stackSize += n;
                        stack.stackSize -= n;
                        left -= n;
                    }
                }
            }
        }
        return count - left;
    }
}
