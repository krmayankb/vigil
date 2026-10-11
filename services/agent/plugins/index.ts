import type { LoadedPlugin, PluginHooks } from "../core/agent.js";
import { SpecError } from "../core/spec.js";
import { pluginFor } from "./registry.js";
import { rootCauseHooks } from "./rootcause/hooks.js";
import { tallyHooks } from "./tally/hooks.js";

// The code a plugin ships beside its manifest, by plugin id. A plugin missing here
// is files alone. Imported statically, so a plugin whose hooks do not compile is a
// build error rather than a run that fails to load them.
const HOOKS: Readonly<Record<string, PluginHooks>> = {
  rootcause: rootCauseHooks,
  tally: tallyHooks,
};

export type Plugin = LoadedPlugin;

export function loadPlugin(id: string, hooks: Readonly<Record<string, PluginHooks>> = HOOKS): Plugin {
  const manifest = pluginFor(id);
  const own = hooks[id];
  return own === undefined ? { manifest } : { manifest, hooks: own };
}

// Plugins whose hooks are built per run from what only the worker holds -- the
// directive queue, the console mirror -- and so cannot yet be handed work by
// another plugin. Every other plugin, files alone or with hooks of its own, can.
const NEEDS_WORKER = new Set(["hunt", "adjudicate", "compose", "chat"]);

// What a delegation runs: the plugin, if another run may hand it work.
export function delegablePlugin(id: string): Plugin {
  if (NEEDS_WORKER.has(id)) throw new SpecError(`plugin ${id} cannot be handed work by another run yet: its hooks are built by the worker`);
  return loadPlugin(id);
}
