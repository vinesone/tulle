import { Effect } from '../core/Effect.js'

export class ChromaticAberration extends Effect {
  static fragSrc = /* glsl */`#version 300 es
    precision highp float;

    in vec2 vUv;

    uniform sampler2D u_source;
    uniform vec2      u_resolution;

    // How far R and B drift from G, in UV space.
    // Range: 0 (none) → ~0.05 (heavy). Default: 0.01
    uniform float spread;

    out vec4 fragColor;

    void main() {
      // Lens-style: channels separate radially from center.
      // The further a pixel is from center, the wider the fringe.
      vec2 dir = (vUv - vec2(0.5)) * spread;

      float r = texture(u_source, vUv - dir).r;
      float g = texture(u_source, vUv      ).g;
      float b = texture(u_source, vUv + dir).b;
      float a = texture(u_source, vUv      ).a;

      fragColor = vec4(r, g, b, a);
    }
  `

  static defaults = {
    spread: 0.01
  }

  static uniforms = {
    spread: 'float'
  }
}
