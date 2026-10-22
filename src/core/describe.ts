import { DEFAULT_ENUM_MIN_SAMPLES, formatOf, isEnum, variantsOf, type LeafShape, type Shape, type StringShape } from './shape';

export interface DescribeOptions {
  /** Observations needed before a closed set of strings is shown as an enum. Default 20. */
  enumMinSamples?: number;
  /** Maximum enum values listed before collapsing to `string`. Default 6. */
  maxEnumValues?: number;
}

/**
 * A compact, human-readable type for a shape:
 * `string<date-time>`, `integer | null`, `"active" | "paused"`, `object[]`.
 */
export function describe(shape: Shape, options: DescribeOptions = {}): string {
  const variants = variantsOf(shape);
  // `string | null` reads better than `null | string`: null goes last.
  const ordered: LeafShape[] = variants.filter((v) => v.kind !== 'null');
  if (ordered.length < variants.length) ordered.push(variants[0]);
  return ordered.map((v) => describeLeaf(v, options)).join(' | ');
}

function describeLeaf(shape: Shape, options: DescribeOptions): string {
  switch (shape.kind) {
    case 'string':
      return describeString(shape, options);
    case 'array': {
      if (!shape.items) return 'unknown[]';
      const inner = describe(shape.items, options);
      return inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object':
      if (Object.keys(shape.properties).length === 0 && shape.additional) {
        return `Record<string, ${describe(shape.additional, options)}>`;
      }
      return 'object';
    default:
      return shape.kind;
  }
}

function describeString(shape: StringShape, options: DescribeOptions): string {
  const min = options.enumMinSamples ?? DEFAULT_ENUM_MIN_SAMPLES;
  const maxList = options.maxEnumValues ?? 6;
  if (isEnum(shape, min) && shape.values && shape.values.length <= maxList) {
    return shape.values.map((v) => JSON.stringify(v)).join(' | ');
  }
  const f = formatOf(shape);
  return f ? `string<${f}>` : 'string';
}
