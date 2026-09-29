"use client";

import { useRef, useCallback } from "react";
import {
  Undo2,
  Redo2,
  Type,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code2,
  ListOrdered,
  List,
  Link2,
  AlignLeft,
  MoreHorizontal,
} from "lucide-react";
import { clsx } from "clsx";

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
}

const TOOLBAR = [
  { icon: Undo2, command: "undo", label: "Undo" },
  { icon: Redo2, command: "redo", label: "Redo" },
  { icon: Type, command: "formatBlock", arg: "p", label: "Paragraph" },
  { icon: Bold, command: "bold", label: "Bold" },
  { icon: Italic, command: "italic", label: "Italic" },
  { icon: Underline, command: "underline", label: "Underline" },
  { icon: Strikethrough, command: "strikeThrough", label: "Strikethrough" },
  { icon: Code2, command: "formatBlock", arg: "pre", label: "Code block" },
  { icon: ListOrdered, command: "insertOrderedList", label: "Numbered list" },
  { icon: List, command: "insertUnorderedList", label: "Bullet list" },
  { icon: AlignLeft, command: "justifyLeft", label: "Align" },
  { icon: Link2, command: "createLink", label: "Insert link" },
  { icon: MoreHorizontal, command: "removeFormat", label: "Clear formatting" },
];

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Type your reply…",
  minHeight = 240,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);

  const run = useCallback((command: string, arg?: string) => {
    if (command === "createLink") {
      const url = window.prompt("Link URL", "https://");
      if (!url) return;
      document.execCommand(command, false, url);
    } else if (arg) {
      document.execCommand(command, false, arg);
    } else {
      document.execCommand(command, false);
    }
    editorRef.current?.focus();
  }, []);

  const handleInput = useCallback(() => {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }, [onChange]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
      handleInput();
    },
    [handleInput],
  );

  return (
    <div className="editor-shell">
      <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
        {TOOLBAR.map((tool, i) => {
          const Icon = tool.icon;
          return (
            <button
              key={`${tool.command}-${i}`}
              type="button"
              onClick={() => run(tool.command, tool.arg)}
              className={clsx("editor-btn", i === 2 && "mr-1.5 border-r border-line")}
              aria-label={tool.label}
              title={tool.label}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="relative">
        {value === "" || value === "<br>" ? (
          <span className="editor-placeholder absolute left-4 top-3 select-none pointer-events-none">
            {placeholder}
          </span>
        ) : null}

        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onPaste={handlePaste}
          className="editor-area rte"
          style={{ minHeight }}
          role="textbox"
          aria-multiline="true"
          aria-label="Email body"
        />
      </div>
    </div>
  );
}
