package alu.aiplayer.act;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.init.Blocks;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.util.MathHelper;
import net.minecraft.world.World;

/** Would removing just this block take the floor away from under the actual player's feet? */
public final class DigFooting {

    private DigFooting() {}

    /** Include collision surfaces exactly at either end of the allowed drop (AABB intersections are open). */
    private static final double EPS = 1e-6;

    public static boolean unsafe(EntityPlayerMP p, int x, int y, int z, int maxDrop) {
        AxisAlignedBB body = p.boundingBox;
        if (body.maxX <= x || body.minX >= x + 1 || body.maxZ <= z || body.minZ >= z + 1 || y > body.minY) return false;
        double feet = body.minY;
        // Instant mining can start the next cell before the player lands on it. While actually falling,
        // include that next landing; a stationary hover or a side dig doesn't rely on a block below it.
        boolean falling = !p.onGround && !p.isInWater() && !p.isOnLadder() && p.posY < p.prevPosY;
        AxisAlignedBB probe = AxisAlignedBB.getBoundingBox(body.minX, (falling ? y : feet) - EPS, body.minZ,
            body.maxX, feet + EPS, body.maxZ);
        List<AxisAlignedBB> boxes = new ArrayList<>();
        int released = releasedThrough(p.worldObj, x, y, z, feet);
        double top = Double.NEGATIVE_INFINITY;
        for (int cy = y; cy <= released; cy++) top = Math.max(top, highestTop(p, x, cy, z, probe, boxes));
        if (top == Double.NEGATIVE_INFINITY) return false;
        // Another surface above the target already catches the fall, even if that fall started further up.
        probe.minY = Math.min(feet - maxDrop, top) - EPS;
        return !hasLanding(p, x, y, released, z, probe, boxes);
    }

    /** Sand, gravel and anvils schedule a fall when the block immediately below them disappears. Each
     * vacates its original cell and releases the next; don't count their future landing as a solid floor. */
    private static int releasedThrough(World w, int x, int y, int z, double feet) {
        int last = y;
        while (last + 1 <= feet && w.blockExists(x, last + 1, z)) {
            Block b = w.getBlock(x, last + 1, z);
            // Modded BlockFalling subclasses can override neighbor updates; use vanilla's known behavior.
            if (b != Blocks.sand && b != Blocks.gravel && b != Blocks.anvil) break;
            last++;
        }
        return last;
    }

    /** A player can be balancing outside the target's column, with no floor at their own cell's centre. */
    public static boolean canCenterBeside(EntityPlayerMP p, int bx, int by, int bz, int maxDrop) {
        double px = MathHelper.floor_double(p.posX) + 0.5, pz = MathHelper.floor_double(p.posZ) + 0.5;
        double half = p.width / 2.0, feet = p.boundingBox.minY;
        AxisAlignedBB probe = AxisAlignedBB.getBoundingBox(px - half, feet - maxDrop - EPS, pz - half,
            px + half, feet + EPS, pz + half);
        return hasLanding(p, bx, by, releasedThrough(p.worldObj, bx, by, bz, feet), bz, probe, new ArrayList<>());
    }

    private static boolean hasLanding(EntityPlayerMP p, int x, int fromY, int throughY, int z, AxisAlignedBB probe,
        List<AxisAlignedBB> boxes) {
        World w = p.worldObj;
        int bottom = Math.max(0, MathHelper.floor_double(probe.minY) - 1); // fences extend above their cell
        for (int cy = MathHelper.floor_double(probe.maxY); cy >= bottom; cy--) {
            for (int cx = MathHelper.floor_double(probe.minX); cx < probe.maxX; cx++) {
                for (int cz = MathHelper.floor_double(probe.minZ); cz < probe.maxZ; cz++) {
                    if ((cx == x && cz == z && cy >= fromY && cy <= throughY) || !w.blockExists(cx, cy, cz)) continue;
                    // A liquid landing within range counts too, as it does on walking routes. Not a lava landing.
                    Material m = w.getBlock(cx, cy, cz).getMaterial();
                    if (m.isLiquid() && m != Material.lava && cy + 1 > probe.minY && cy < probe.maxY) return true;
                    if (highestTop(p, cx, cy, cz, probe, boxes) != Double.NEGATIVE_INFINITY) return true;
                }
            }
        }
        return false;
    }

    private static double highestTop(EntityPlayerMP p, int x, int y, int z, AxisAlignedBB probe, List<AxisAlignedBB> boxes) {
        World w = p.worldObj;
        Block b = w.getBlock(x, y, z);
        boxes.clear();
        b.addCollisionBoxesToList(w, x, y, z, probe, boxes, p);
        double top = Double.NEGATIVE_INFINITY;
        for (AxisAlignedBB bb : boxes) {
            if (bb.intersectsWith(probe) && bb.maxY < probe.maxY) top = Math.max(top, bb.maxY);
        }
        return top;
    }
}
