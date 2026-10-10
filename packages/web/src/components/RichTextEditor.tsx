import { useState } from 'react';
import { EditorContent, useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The editable message body. The editor instance is owned by the compose window. */
export function RichTextBody(props: { editor: Editor; className?: string }): React.JSX.Element {
  return (
    <EditorContent
      editor={props.editor}
      aria-label="Message"
      className={cn('compose-editor cursor-text text-sm', props.className)}
      onClick={() => props.editor.chain().focus().run()}
    />
  );
}

/** Compact formatting toolbar: inline marks, lists, quote, link, clear. */
export function FormattingToolbar(props: { editor: Editor }): React.JSX.Element {
  const active = useEditorState({
    editor: props.editor,
    selector: (snapshot) => ({
      bold: snapshot.editor.isActive('bold'),
      italic: snapshot.editor.isActive('italic'),
      underline: snapshot.editor.isActive('underline'),
      strike: snapshot.editor.isActive('strike'),
      bulletList: snapshot.editor.isActive('bulletList'),
      orderedList: snapshot.editor.isActive('orderedList'),
      blockquote: snapshot.editor.isActive('blockquote'),
      link: snapshot.editor.isActive('link'),
    }),
  });

  return (
    <div role="toolbar" aria-label="Formatting" className="flex items-center gap-px">
      <Mark
        label="Bold"
        shortcut="⌘B"
        pressed={active.bold}
        onToggle={() => props.editor.chain().focus().toggleBold().run()}
      >
        <Bold />
      </Mark>
      <Mark
        label="Italic"
        shortcut="⌘I"
        pressed={active.italic}
        onToggle={() => props.editor.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </Mark>
      <Mark
        label="Underline"
        shortcut="⌘U"
        pressed={active.underline}
        onToggle={() => props.editor.chain().focus().toggleUnderline().run()}
      >
        <Underline />
      </Mark>
      <Mark
        label="Strikethrough"
        pressed={active.strike}
        onToggle={() => props.editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough />
      </Mark>
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <Mark
        label="Bulleted list"
        pressed={active.bulletList}
        onToggle={() => props.editor.chain().focus().toggleBulletList().run()}
      >
        <List />
      </Mark>
      <Mark
        label="Numbered list"
        pressed={active.orderedList}
        onToggle={() => props.editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered />
      </Mark>
      <Mark
        label="Quote"
        pressed={active.blockquote}
        onToggle={() => props.editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote />
      </Mark>
      <LinkControl editor={props.editor} active={active.link} />
      <Mark
        label="Clear formatting"
        pressed={false}
        onToggle={() => props.editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        <RemoveFormatting />
      </Mark>
    </div>
  );
}

function Mark(props: {
  label: string;
  shortcut?: string;
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          aria-label={props.label}
          pressed={props.pressed}
          onPressedChange={props.onToggle}
          className="size-7 min-w-7 p-0 text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground [&_svg]:size-3.5"
        >
          {props.children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>
        {props.label}
        {props.shortcut && <span className="ml-2 opacity-60">{props.shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function LinkControl(props: { editor: Editor; active: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');

  function apply(event: React.FormEvent): void {
    event.preventDefault();
    const value = href.trim();
    const chain = props.editor.chain().focus().extendMarkRange('link');
    if (value === '') {
      chain.unsetLink().run();
    } else {
      chain.setLink({ href: /^[a-z]+:/i.test(value) ? value : `https://${value}` }).run();
    }
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setHref((props.editor.getAttributes('link').href as string | undefined) ?? '');
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Toggle
              size="sm"
              aria-label="Link"
              pressed={props.active}
              className="size-7 min-w-7 p-0 text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground [&_svg]:size-3.5"
            >
              <Link2 />
            </Toggle>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Link</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-72 p-2">
        <form onSubmit={apply} className="flex gap-1.5">
          <input
            autoFocus
            aria-label="Link URL"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder="https://"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm">
            {href.trim() === '' && props.active ? 'Remove' : 'Apply'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
