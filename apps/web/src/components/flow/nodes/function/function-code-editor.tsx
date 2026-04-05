import { useState, useCallback, useEffect, useRef } from "react";
import Editor, { loader, type OnMount, type Monaco } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/providers/theme-provider";

// Use local bundle + workers instead of CDN (required for offline Tauri)
(window as Window & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tsLang = (monaco.languages as any).typescript as {
  typescriptDefaults: {
    setDiagnosticsOptions: (opts: Record<string, unknown>) => void;
    setCompilerOptions: (opts: Record<string, unknown>) => void;
    addExtraLib: (content: string, filePath: string) => void;
  };
  ScriptTarget: { ES2020: number };
};

tsLang.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
tsLang.typescriptDefaults.setCompilerOptions({
  target: tsLang.ScriptTarget.ES2020,
  allowNonTsExtensions: true,
  checkJs: true,
  strict: false,
});

const PREFIX = "function trigger(input: unknown) {\n";
const SUFFIX = "\n}";

function wrap(body: string) {
  const indented = body
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${PREFIX}${indented}${SUFFIX}`;
}

function unwrap(full: string) {
  const lines = full.split("\n");
  return lines
    .slice(1, -1)
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
}

type Props = {
  code: string;
  dynamicVars: string[];
  onSave: (code: string) => void;
  onClose: () => void;
};

export function FunctionCodeEditor({ code, dynamicVars, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(code);
  const { theme } = useTheme();
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!monacoRef.current) return;
    publishDeclarations(dynamicVars);
  }, [dynamicVars]);

  const onMount: OnMount = useCallback(
    (editor, m) => {
      monacoRef.current = m;
      editorRef.current = editor;
      publishDeclarations(dynamicVars);
      lockWrapperLines(editor);
      setupTemplateSupport(editor, m);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleChange = useCallback((value: string | undefined) => {
    if (!value) return;
    setDraft(unwrap(value));
  }, []);

  return (
    <Dialog defaultOpen onOpenChange={onClose}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>Edit function</DialogTitle>
        </DialogHeader>
        <div className="flex-1 h-[60vh] border-y">
          <Editor
            height="100%"
            language="typescript"
            defaultValue={wrap(code)}
            onChange={handleChange}
            theme={theme === "dark" ? "vs-dark" : "light"}
            onMount={onMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
              padding: { top: 12, bottom: 12 },
            }}
          />
        </div>
        <DialogFooter className="px-6 py-4 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <DialogClose>
            <Button onClick={() => onSave(draft)}>Save</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Lock the wrapper lines (first and last) so users can only edit the body.
 */
function lockWrapperLines(editor: MonacoEditor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  if (!model) return;

  const totalLines = model.getLineCount();

  editor.createDecorationsCollection([
    {
      range: new monaco.Range(1, 1, 1, model.getLineMaxColumn(1)),
      options: { inlineClassName: "opacity-50 pointer-events-none", isWholeLine: true },
    },
    {
      range: new monaco.Range(totalLines, 1, totalLines, model.getLineMaxColumn(totalLines)),
      options: { inlineClassName: "opacity-50 pointer-events-none", isWholeLine: true },
    },
  ]);

  editor.onDidChangeModelContent(() => {
    const lineCount = model.getLineCount();
    const firstLine = model.getLineContent(1);
    const lastLine = model.getLineContent(lineCount);
    if (firstLine !== "function trigger(input: unknown) {" || lastLine !== "}") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (editor as any).trigger("lockWrapperLines", "undo", null);
    }
  });

  editor.setPosition({ lineNumber: 2, column: 3 });
  editor.focus();
}

/**
 * Highlight `{{VAR}}` template tokens and suppress TS diagnostics caused by them.
 *
 * `{{VAR}}` is not valid TS, so the parser emits cascading errors. When any
 * template token is present we suppress all TS diagnostics (the runtime handles
 * validation). Template tokens get a visual highlight + hover tooltip.
 */
function setupTemplateSupport(editor: MonacoEditor.IStandaloneCodeEditor, m: Monaco) {
  const model = editor.getModel();
  if (!model) return;

  const uri = model.uri;
  const decorations = editor.createDecorationsCollection([]);

  const update = () => {
    const allMatches = model.findMatches("\\{\\{\\w+\\}\\}", false, true, false, null, false);

    // Filter out matches that are inside comments (for diagnostic suppression only)
    const activeMatches = allMatches.filter((match) => {
      const line = model.getLineContent(match.range.startLineNumber);
      const before = line.slice(0, match.range.startColumn - 1);
      return !before.includes("//");
    });

    // Highlight ALL template tokens (including commented ones) for visual consistency
    decorations.set(
      allMatches.map((match) => ({
        range: match.range,
        options: {
          inlineClassName: "template-variable-highlight",
          hoverMessage: {
            value: `Template variable — creates a connectable handle on the node`,
          },
        },
      })),
    );

    // Only suppress TS diagnostics when non-comment templates are present
    if (activeMatches.length > 0) {
      m.editor.setModelMarkers(model, "typescript", []);
    }
  };

  m.editor.onDidChangeMarkers((uris: readonly monaco.Uri[]) => {
    if (uris.some((u: monaco.Uri) => u.toString() === uri.toString())) {
      update();
    }
  });

  model.onDidChangeContent(() => update());
  setTimeout(update, 300);
}

/** Built-in utility function type declarations available inside the function editor. */
const BUILTIN_LIB = `
/**
 * Coerce any value to a number.
 * Returns \`fallback\` (default \`0\`) when the result would be \`NaN\`.
 *
 * @param value - The value to coerce
 * @param fallback - Value to return when coercion yields NaN (default: \`0\`)
 * @returns The numeric representation of the value, or the fallback
 *
 * @example
 * const n = toNumber(input);       // 0 if input is not numeric
 * const n = toNumber(input, -1);   // -1 as fallback
 */
declare function toNumber(value: unknown, fallback?: number): number;

/**
 * Coerce any value to a string.
 * Objects and arrays are JSON-stringified.
 *
 * @param value - The value to coerce
 * @returns The string representation of the value
 *
 * @example
 * const s = toString(input);       // always a string
 */
declare function toString(value: unknown): string;

/**
 * Coerce any value to a boolean using JavaScript truthiness,
 * with special handling: the strings \`"false"\`, \`"0"\`, and \`""\` return \`false\`.
 *
 * @param value - The value to coerce
 * @returns The boolean representation of the value
 *
 * @example
 * const b = toBool(input);
 */
declare function toBool(value: unknown): boolean;

/**
 * Return the value as a number if it falls within \`[min, max]\`.
 * Otherwise return \`fallback\` (default \`min\`).
 *
 * @param value - The value to check
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @param fallback - Value to return when out of range (default: \`min\`)
 * @returns The value if in range, otherwise the fallback
 *
 * @example
 * const safe = ensureRange(input, 0, 255);       // min (0) as fallback
 * const safe = ensureRange(input, 0, 255, 128);  // 128 as fallback
 */
declare function ensureRange(value: unknown, min: number, max: number, fallback?: number): number;

/**
 * Return the value if it is strictly equal to one of the \`allowed\` entries,
 * otherwise return \`fallback\`.
 *
 * @param value - The value to check
 * @param allowed - Array of allowed values
 * @param fallback - Value to return when not in the allowed list
 * @returns The value if allowed, otherwise the fallback
 *
 * @example
 * const mode = oneOf(input, ["on", "off", "blink"], "off");
 */
declare function oneOf<T>(value: unknown, allowed: T[], fallback: T): T;

/**
 * Return \`true\` if the value is not \`null\`, \`undefined\`, or \`NaN\`.
 *
 * @param value - The value to check
 * @returns Whether the value is valid (not null, undefined, or NaN)
 *
 * @example
 * if (!isValid(input)) return 0;
 */
declare function isValid(value: unknown): boolean;
`;

function publishDeclarations(vars: string[]) {
  const varDecls = vars
    .map((v) => `/** Template variable {{${v}}} — connected via a bottom handle */\ndeclare var ${v}: any;`)
    .join("\n");
  tsLang.typescriptDefaults.addExtraLib(BUILTIN_LIB + "\n" + varDecls, "ts:function-context.d.ts");
}
