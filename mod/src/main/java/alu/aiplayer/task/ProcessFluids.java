package alu.aiplayer.task;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

import net.minecraftforge.fluids.FluidStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.util.J;

/** Two independent measurements: GT's pending products for completed rounds, and the change in visible stock. */
final class ProcessFluids {

    private final Map<String, Long> made = new LinkedHashMap<>();
    private final Map<String, Long> pending = new LinkedHashMap<>();
    private JsonArray before;

    void start(JsonArray tanks) {
        before = tanks;
    }

    void recipe(FluidStack[] products) {
        pending.clear();
        if (products != null) for (FluidStack f : products) {
            if (f != null && f.getFluid() != null && f.amount > 0) pending.merge(f.getFluid().getName(), (long) f.amount, Long::sum);
        }
    }

    void completed() {
        for (Map.Entry<String, Long> e : pending.entrySet()) made.merge(e.getKey(), e.getValue(), Long::sum);
        pending.clear();
    }

    private static Map<String, Long> amounts(JsonArray tanks) {
        Map<String, Long> total = new LinkedHashMap<>();
        for (JsonElement e : tanks) {
            JsonObject tank = e.getAsJsonObject();
            if (tank.has("unreadable")) return null;
            if (tank.has("fluid")) total.merge(J.str(tank, "fluid", ""), (long) J.i(tank, "amount", 0), Long::sum);
        }
        return total;
    }

    private static Set<String> hatchPositions(JsonArray tanks) {
        Set<String> positions = new LinkedHashSet<>();
        for (JsonElement e : tanks) {
            JsonObject t = e.getAsJsonObject();
            if (t.has("x")) positions.add(t.get("x") + "," + t.get("y") + "," + t.get("z"));
        }
        return positions;
    }

    void report(JsonObject result, JsonArray after, boolean observation) {
        if (!made.isEmpty()) {
            JsonArray products = new JsonArray();
            for (Map.Entry<String, Long> e : made.entrySet()) {
                JsonObject f = new JsonObject();
                f.addProperty("fluid", e.getKey());
                f.addProperty("amount", e.getValue());
                products.add(f);
            }
            result.add(observation ? "observedMadeFluids" : "madeFluids", products);
        }
        if (before == null || after == null) return;
        // An empty tank is a reading (amount 0); no tanks is not a measurement of zero mB.
        if (observation || !made.isEmpty() || !before.equals(after)) result.add("fluids", after);
        if (before.size() == 0 || after.size() == 0 || !hatchPositions(before).equals(hatchPositions(after))) return;
        Map<String, Long> was = amounts(before), now = amounts(after);
        if (was == null || now == null) return;
        Set<String> kinds = new LinkedHashSet<>(was.keySet());
        kinds.addAll(now.keySet());
        JsonArray changes = new JsonArray();
        for (String fluid : kinds) {
            long a = was.getOrDefault(fluid, 0L), b = now.getOrDefault(fluid, 0L);
            if (a == b) continue;
            JsonObject change = new JsonObject();
            change.addProperty("fluid", fluid);
            change.addProperty("before", a);
            change.addProperty("after", b);
            change.addProperty("delta", b - a);
            changes.add(change);
        }
        if (changes.size() > 0 || !made.isEmpty()) result.add("fluidChanges", changes); // []: measured, no net change
    }
}
