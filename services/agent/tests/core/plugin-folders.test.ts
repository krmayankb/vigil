import { describe, expect, it } from "vitest";
import { delegablePlugin } from "../../plugins/index.js";
import { KIND_PLUGINS } from "../../plugins/kinds.js";
import { pluginFor, pluginIds } from "../../plugins/registry.js";

// A plugin is a folder: every one shipped loads, every kind names one, and every
// piece of work a plugin hands off names a plugin that can take it.
describe("the plugin folders", () => {
  const ids = pluginIds();

  it("load, each under its own name", () => {
    for (const id of ids) expect(pluginFor(id).id).toBe(id);
  });

  it("include the plugin every run kind runs on", () => {
    for (const plugin of Object.values(KIND_PLUGINS)) expect(ids).toContain(plugin);
  });

  it("hand work only to plugins that exist and can take it", () => {
    for (const id of ids) {
      for (const delegate of pluginFor(id).delegates ?? []) {
        expect(() => delegablePlugin(delegate.plugin), `${id} hands ${delegate.verb} to ${delegate.plugin}`).not.toThrow();
      }
    }
  });
});
