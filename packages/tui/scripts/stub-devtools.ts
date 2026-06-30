/**
 * Build plugin: stub out Ink's optional `react-devtools-core` import so the compiled
 * binary doesn't need it bundled. Ink only touches devtools in dev mode, so an empty
 * stub is safe at runtime.
 */

export default {
  name: "stub-react-devtools-core",
  setup(build: import("bun").PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default undefined;\nexport const connectToDevtools = () => {};\n",
      loader: "js",
    }));
  },
};
