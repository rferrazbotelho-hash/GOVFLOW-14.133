import React, { useEffect } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Highlight from '@tiptap/extension-highlight';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Save,
  Table2,
  Underline as UnderlineIcon,
  Undo2
} from 'lucide-react';

/** Preserva imagens inline (ex: Brasão Municipal base64 no Bloco A do Agente 11) dentro do TipTap. */
const InlineImageNode = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  draggable: false,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      style: { default: null }
    };
  },
  parseHTML() {
    return [{ tag: 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  }
});

interface Props {
  htmlContent: string;
  editable: boolean;
  isDirty: boolean;
  onChange: (html: string) => void;
  onSave: () => void;
  saving?: boolean;
}

export const RichDocumentEditor: React.FC<Props> = ({
  htmlContent,
  editable,
  isDirty,
  onChange,
  onSave,
  saving
}) => {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      InlineImageNode
    ],
    content: htmlContent || '<p></p>',
    editable,
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    }
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (htmlContent !== current && !editor.isFocused) {
      editor.commands.setContent(htmlContent || '<p></p>', false);
    }
  }, [editor, htmlContent]);

  if (!editor) return null;

  const btnClass = (active = false) =>
    `p-1.5 rounded text-xs transition-colors cursor-pointer ${
      active
        ? 'bg-[#1351B4] text-white'
        : 'text-slate-600 hover:bg-slate-200/80 hover:text-slate-900'
    }`;

  return (
    <div className="bg-white border-x border-b border-slate-200 rounded-b-xl shadow-xs">
      {/* Barra de Ferramentas Estilo Notion / Google Docs */}
      {editable && (
        <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              title="Título de Seção (H2)"
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={btnClass(editor.isActive('heading', { level: 2 }))}
            >
              <Heading2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Subtítulo (H3)"
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              className={btnClass(editor.isActive('heading', { level: 3 }))}
            >
              <Heading3 className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-slate-300 mx-1" />

            <button
              type="button"
              title="Negrito"
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={btnClass(editor.isActive('bold'))}
            >
              <Bold className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Itálico"
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={btnClass(editor.isActive('italic'))}
            >
              <Italic className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Sublinhado"
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              className={btnClass(editor.isActive('underline'))}
            >
              <UnderlineIcon className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-slate-300 mx-1" />

            <button
              type="button"
              title="Alinhar à Esquerda"
              onClick={() => editor.chain().focus().setTextAlign('left').run()}
              className={btnClass(editor.isActive({ textAlign: 'left' }))}
            >
              <AlignLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Centralizar"
              onClick={() => editor.chain().focus().setTextAlign('center').run()}
              className={btnClass(editor.isActive({ textAlign: 'center' }))}
            >
              <AlignCenter className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Alinhar à Direita"
              onClick={() => editor.chain().focus().setTextAlign('right').run()}
              className={btnClass(editor.isActive({ textAlign: 'right' }))}
            >
              <AlignRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Justificar"
              onClick={() => editor.chain().focus().setTextAlign('justify').run()}
              className={btnClass(editor.isActive({ textAlign: 'justify' }))}
            >
              <AlignJustify className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-slate-300 mx-1" />

            <button
              type="button"
              title="Lista com Marcadores"
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={btnClass(editor.isActive('bulletList'))}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Lista Numerada"
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              className={btnClass(editor.isActive('orderedList'))}
            >
              <ListOrdered className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Inserir Tabela"
              onClick={() =>
                editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
              }
              className={btnClass(editor.isActive('table'))}
            >
              <Table2 className="w-4 h-4" />
            </button>

            {editor.isActive('table') && (
              <div className="flex items-center gap-1 ml-1 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 text-[11px]">
                <button
                  type="button"
                  onClick={() => editor.chain().focus().addRowAfter().run()}
                  className="text-[#1351B4] hover:underline font-medium cursor-pointer"
                >
                  +Linha
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().addColumnAfter().run()}
                  className="text-[#1351B4] hover:underline font-medium cursor-pointer"
                >
                  +Coluna
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().deleteRow().run()}
                  className="text-rose-600 hover:underline font-medium cursor-pointer"
                >
                  -Linha
                </button>
              </div>
            )}

            <div className="w-px h-5 bg-slate-300 mx-1" />

            <button
              type="button"
              title="Desfazer"
              onClick={() => editor.chain().focus().undo().run()}
              className={btnClass(false)}
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Refazer"
              onClick={() => editor.chain().focus().redo().run()}
              className={btnClass(false)}
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            disabled={!isDirty || saving}
            onClick={onSave}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              isDirty
                ? 'bg-[#168821] hover:bg-[#126E1B] text-white shadow-xs'
                : 'bg-slate-200 text-slate-500 cursor-not-allowed'
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Salvando...' : isDirty ? 'Salvar Edição (Nova Versão)' : 'Salvo'}
          </button>
        </div>
      )}

      {/* Área Editorial do Documento */}
      <div className="p-6 md:px-10 md:py-8 min-h-[540px] govflow-prose">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};
