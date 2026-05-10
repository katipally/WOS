# WorkOS Plugin SDK -- `hello` sample

This is a minimal example plugin that registers a single tool, `hello__greet`.

## Install

Copy this folder to your WOS plugins directory:

```sh
cp -R examples/plugins/hello ~/.wos/plugins/hello
```

Then restart WOS. On boot you should see:

```
[plugins] loaded hello@1.0.0 (1 tool)
```

Ask the chat agent to "use the greet tool" and it will call `hello__greet`
and print a greeting.

## Authoring your own plugin

1. Create a folder under `~/.wos/plugins/<id>/` whose name matches the
   `id` field in the manifest.
2. Add a `wos-plugin.json` manifest:
   ```json
   {
     "id": "<id>",
     "name": "Your Plugin",
     "version": "1.0.0",
     "entry": "index.js",
     "description": "...",
     "kinds": ["tool"],
     "permissions": []
   }
   ```
3. Add an entry file (CommonJS `.js` or ESM `.mjs`) that exports `register(api)`:
   ```js
   function register(api) {
     api.defineTool({
       name: 'do-thing',
       description: 'Does the thing.',
       inputSchema: { type: 'object', properties: {}, additionalProperties: false },
       async handler(input, ctx) {
         return { output: 'done' }
       },
     })
   }
   module.exports = { register }
   ```

## Trust model

Plugins run inside the main process with no sandbox in v1. Only install
plugins you wrote or fully trust; they have full access to the user's machine.
The `permissions` field is currently advisory and logged at load time;
enforcement will arrive in a later release.

See `electron/main/plugins/types.ts` for the full registration API surface.
