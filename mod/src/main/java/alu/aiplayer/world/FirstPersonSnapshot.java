package alu.aiplayer.world;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;
import net.minecraft.util.Vec3;
import net.minecraft.world.World;

import com.google.gson.JsonObject;

import alu.aiplayer.act.Sight;
import alu.aiplayer.bridge.RpcException;

/** Read-only eye-level observation. Called once on the server thread, without yielding or loading chunks. */
public final class FirstPersonSnapshot {

    private FirstPersonSnapshot() {}

    private static JsonObject vector(Vec3 v) {
        JsonObject out = new JsonObject();
        out.addProperty("x", v.xCoord);
        out.addProperty("y", v.yCoord);
        out.addProperty("z", v.zCoord);
        return out;
    }

    public static JsonObject capture(EntityPlayerMP player, int radius) {
        // world.blocks allows at most 64 cells per side; a centred integer radius r spans 2r+1.
        if (radius < 0 || radius > 31) throw RpcException.badRequest("radius must be between 0 and 31 (world.blocks side limit: 64)");
        long began = System.nanoTime();
        World w = player.worldObj;
        Vec3 eye = Sight.eyes(player), look = Sight.look(player);
        int x = MathHelper.floor_double(eye.xCoord), y = MathHelper.floor_double(eye.yCoord);
        int z = MathHelper.floor_double(eye.zCoord);
        JsonObject out = new JsonObject();
        out.addProperty("version", 1);
        out.addProperty("bot", player.getCommandSenderName());
        out.addProperty("dim", w.provider.dimensionId);
        out.addProperty("tick", w.getTotalWorldTime());
        out.addProperty("time", w.getWorldTime());
        out.addProperty("capturedAt", System.currentTimeMillis());
        JsonObject camera = new JsonObject();
        camera.add("eye", vector(eye));
        camera.add("look", vector(look));
        camera.addProperty("yaw", player.rotationYaw);
        camera.addProperty("pitch", player.rotationPitch);
        out.add("camera", camera);
        // WorldQueries.blocks checks blockExists before each read and marks missing chunks as '?'.
        out.add("blocks", WorldQueries.blocks(w, x - radius, Math.max(0, y - radius), z - radius,
            x + radius, Math.min(255, y + radius), z + radius));
        out.addProperty("captureDurationMs", (System.nanoTime() - began) / 1_000_000.0);
        return out;
    }
}
