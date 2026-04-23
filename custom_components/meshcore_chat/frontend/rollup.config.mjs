import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

const dev = process.env.ROLLUP_WATCH === 'true';

export default {
  input: 'src/meshcore-chat-panel.ts',
  output: {
    file: 'dist/meshcore-chat-panel.js',
    format: 'es',
    sourcemap: dev,
  },
  plugins: [
    resolve(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: false,
      sourceMap: dev,
      include: ['src/**/*.ts'],
    }),
    !dev &&
      terser({
        compress: {
          drop_console: false,
          passes: 2,
        },
        format: {
          comments: false,
        },
      }),
  ].filter(Boolean),
};
