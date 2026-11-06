/**
 * Numbered-section rendering of the form, driven by the schema's `x-form-layout`.
 *
 * @module apps/web/components/forms/rjsf-theme/SectionedObject
 */
import type { ObjectFieldTemplateProps, RJSFSchema } from '@rjsf/utils';
import { z } from 'zod';

/**
 * Schema-authored form layout (`x-form-layout` on the item schema).
 *
 * `sections` gives the grouping and field order; `twoColumn` names fields that
 * can sit two per row. The Signals profile form reads the same block. A section
 * may omit its title or its field list; one with no fields is skipped.
 */
const FormLayoutSchema = z.object({
  sections: z.array(
    z.object({ title: z.string().optional(), fields: z.array(z.string()).optional() }),
  ),
  twoColumn: z.array(z.string()).optional(),
});

type FormLayout = z.infer<typeof FormLayoutSchema>;

/** One child field slot of `ObjectFieldTemplate`. */
export type ObjectProperty = ObjectFieldTemplateProps['properties'][number];

/**
 * Reads the schema's `x-form-layout` block.
 *
 * @param schema - The object schema being rendered.
 * @returns The layout when it is well formed and has at least one section.
 */
export function readFormLayout(schema: RJSFSchema): FormLayout | undefined {
  const parsed = FormLayoutSchema.safeParse(schema['x-form-layout']);
  return parsed.success && parsed.data.sections.length > 0 ? parsed.data : undefined;
}

/**
 * Groups a section's fields into rows, pairing adjacent two-column fields.
 *
 * Every other field gets its own row, so no row is left half empty.
 *
 * @param fields - The section's visible fields, in layout order.
 * @param twoColumn - Field names the layout marks as two-column.
 * @returns Rows of one or two fields.
 */
function packRows(fields: ObjectProperty[], twoColumn: Set<string>): ObjectProperty[][] {
  const rows: ObjectProperty[][] = [];
  let i = 0;
  while (i < fields.length) {
    const current = fields[i]!;
    const next = fields[i + 1];
    if (twoColumn.has(current.name) && next && twoColumn.has(next.name)) {
      rows.push([current, next]);
      i += 2;
    } else {
      rows.push([current]);
      i += 1;
    }
  }
  return rows;
}

/**
 * Renders the form as the schema's numbered sections.
 *
 * A section with no visible fields is skipped, and numbering counts only
 * rendered sections. Fields not listed in the layout render after the sections.
 */
export function SectionedObject({
  layout,
  properties,
}: Readonly<{ layout: FormLayout; properties: ObjectProperty[] }>) {
  const byName = new Map(properties.map((p) => [p.name, p]));
  const twoColumn = new Set(layout.twoColumn ?? []);
  const claimed = new Set<string>();
  let sectionNumber = 0;

  const sections = layout.sections.map((section, layoutIndex) => {
    const fields = (section.fields ?? [])
      .map((name) => byName.get(name))
      .filter((p): p is ObjectProperty => Boolean(p));
    if (fields.length === 0) return null;
    fields.forEach((f) => claimed.add(f.name));
    sectionNumber += 1;
    return {
      // The position in the layout is unique and does not move when a section is hidden.
      key: layoutIndex,
      title: section.title,
      number: sectionNumber,
      rows: packRows(fields, twoColumn),
    };
  });

  const orphans = properties.filter((p) => !claimed.has(p.name));

  return (
    <div className="space-y-8">
      {sections.map(
        (section) =>
          section && (
            <section key={section.key}>
              <div className="mb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-(--bd-primary-50) text-[12px] font-bold text-(--bd-primary-600)">
                    {section.number}
                  </div>
                  <h3 className="font-display text-[15px] font-bold tracking-tight text-ink-900">
                    {section.title}
                  </h3>
                </div>
                <div className="mt-3 h-px bg-linear-to-r from-(--bd-border) to-transparent" />
              </div>
              <div className="space-y-3">
                {section.rows.map((row) =>
                  row.length === 2 ? (
                    <div
                      key={row[0]!.name}
                      className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2"
                    >
                      {row.map((p) => (
                        <div key={p.name}>{p.content}</div>
                      ))}
                    </div>
                  ) : (
                    <div key={row[0]!.name}>{row[0]!.content}</div>
                  ),
                )}
              </div>
            </section>
          ),
      )}
      {orphans.map((p) => (
        <div key={p.name}>{p.content}</div>
      ))}
    </div>
  );
}
