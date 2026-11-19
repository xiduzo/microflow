import { type Data, numberDefaults, rangeDefaults, textDefaults } from "./compare.schema";

const formatter = new Intl.NumberFormat("en-US");

/**
 * What a Compare node says on its face: the comparison it makes. A setting
 * the node does not hold reads as the schema's default, bound by bound for a
 * range.
 */
export function comparisonSummary(data: Data): string {
  switch (data.validator) {
    case "boolean":
      return "boolean";
    case "number":
      return `is ${data.subValidator} ${formatter.format(data.number ?? numberDefaults.number)}`;
    case "oddEven":
      return `is ${data.subValidator}`;
    case "range": {
      const range = { ...rangeDefaults.range, ...data.range };
      return `is ${data.subValidator} ${formatter.format(range.min)} and ${formatter.format(range.max)}`;
    }
    case "text":
      return `is ${data.subValidator} "${data.text ?? textDefaults.text}"`;
    default:
      return "";
  }
}
