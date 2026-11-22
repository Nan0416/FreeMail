import { useCallback, useEffect, useState } from 'react';
import { MAX_FORWARDING_RULE_NAME_LENGTH, checkForwardingRule, type ForwardingRule } from '@freemail/shared';
import { Forward, Menu, Plus, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { EMPTY_FORWARDING_RULE_FORM, fieldsFromForm, fieldsOf, formFromRule, type ForwardingRuleForm } from '../lib/forwarding.js';

export interface ForwardingRulesViewProps {
  /** Shown below `lg`, where the sidebar collapses into a sheet. */
  readonly onOpenNav?: () => void;
}

/** The editor's subject: an existing rule, or `null` for a new one. */
interface Editing {
  readonly rule: ForwardingRule | null;
  /** Remounts the editor per opening, so its form starts from `rule` every time. */
  readonly key: number;
}

/**
 * The forwarding rules: which received mail is copied to which outside addresses. Lists the
 * rules with their conditions, and creates, edits, pauses and deletes them. Saved rules apply
 * to the next received message.
 */
export function ForwardingRulesView(props: ForwardingRulesViewProps): React.JSX.Element {
  const auth = useAuth();
  const [rules, setRules] = useState<readonly ForwardingRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `rules`: an empty list would read as "no rules" and invite a duplicate.
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ForwardingRule | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadFailed(false);
    try {
      const response = await auth.client.listForwardingRules();
      setRules(response.rules);
    } catch (err) {
      setLoadFailed(true);
      setError(err instanceof ApiError ? err.message : 'Could not load the forwarding rules.');
    }
  }, [auth.client]);

  function retry(): void {
    setError(null);
    void refresh();
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openEditor(rule: ForwardingRule | null): void {
    setEditing((prev) => ({ rule, key: (prev?.key ?? 0) + 1 }));
  }

  function onSaved(saved: ForwardingRule, created: boolean): void {
    setEditing(null);
    setRules((prev) => upsert(prev ?? [], saved));
    toast.success(created ? 'Forwarding rule created' : 'Forwarding rule saved');
  }

  async function onToggle(rule: ForwardingRule): Promise<void> {
    setError(null);
    setToggling(rule.id);
    try {
      const saved = await auth.client.updateForwardingRule(rule.id, {
        ...fieldsOf(rule),
        enabled: !rule.enabled,
      });
      setRules((prev) => upsert(prev ?? [], saved));
      toast.success(saved.enabled ? `Resumed ${saved.name}` : `Paused ${saved.name}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the forwarding rule.');
    } finally {
      setToggling(null);
    }
  }

  async function onDelete(rule: ForwardingRule): Promise<void> {
    setError(null);
    setDeleting(null);
    try {
      await auth.client.deleteForwardingRule(rule.id);
      setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
      toast.success('Forwarding rule deleted');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the forwarding rule.');
    }
  }

  return (
    <section aria-label="Forwarding" className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        {props.onOpenNav && (
          <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation" onClick={props.onOpenNav}>
            <Menu />
          </Button>
        )}
        <h1 className="text-[15px] font-semibold tracking-tight">Forwarding</h1>
        <Button size="sm" className="ml-auto gap-1.5" disabled={rules === null} onClick={() => openEditor(null)}>
          <Plus className="size-4" />
          New rule
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-8">
          {error && (
            <p role="alert" className="mb-4 text-[13px] text-destructive">
              {error}
            </p>
          )}

          <div className="rounded-md border">
            {rules === null && loadFailed ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <p className="text-[13px] text-muted-foreground">The rules couldn&rsquo;t be loaded.</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={retry}>
                  Try again
                </Button>
              </div>
            ) : rules === null ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Loading…</p>
            ) : rules.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <Forward className="size-7 text-muted-foreground/50" strokeWidth={1.5} />
                <p className="mt-3 text-[13px] text-muted-foreground">No forwarding rules yet.</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => openEditor(null)}>
                  Create a rule
                </Button>
              </div>
            ) : (
              <ul aria-label="Forwarding rules" className="divide-y">
                {rules.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} toggling={toggling === rule.id} onEdit={() => openEditor(rule)} onToggle={() => void onToggle(rule)} onDelete={() => setDeleting(rule)} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {editing && <RuleEditor key={editing.key} rule={editing.rule} onClose={() => setEditing(null)} onSaved={onSaved} />}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name ?? 'this rule'}?</AlertDialogTitle>
            <AlertDialogDescription>Mail it matches stops being forwarded. To stop it for a while instead, pause it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => deleting && void onDelete(deleting)}>
              Delete rule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RuleRow(props: { rule: ForwardingRule; toggling: boolean; onEdit: () => void; onToggle: () => void; onDelete: () => void }): React.JSX.Element {
  const rule = props.rule;
  const senders = [...rule.senderDomains, ...rule.senderAddresses];
  const recipients = [...rule.recipientDomains, ...rule.recipientAddresses];
  return (
    <li aria-label={rule.name} className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium">{rule.name}</span>
          {!rule.enabled && <Badge variant="secondary">Paused</Badge>}
          {rule.ignoreDmarcVerification && (
            <Badge variant="outline" className="gap-1 text-amber-700 dark:text-amber-400">
              <ShieldAlert />
              Unverified senders
            </Badge>
          )}
        </p>
        <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {senders.length > 0 && <Condition label="From" values={senders} />}
          {recipients.length > 0 && <Condition label="To or Cc" values={recipients} />}
          <Condition label="Forwards to" values={rule.forwardTo} />
        </dl>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" disabled={props.toggling} aria-label={`${rule.enabled ? 'Pause' : 'Resume'} ${rule.name}`} onClick={props.onToggle}>
          {rule.enabled ? 'Pause' : 'Resume'}
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Edit ${rule.name}`} onClick={props.onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Delete ${rule.name}`} className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={props.onDelete}>
          Delete
        </Button>
      </div>
    </li>
  );
}

function Condition(props: { label: string; values: readonly string[] }): React.JSX.Element {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0">{props.label}:</dt>
      <dd className="min-w-0 break-words text-foreground/80">{props.values.join(', ')}</dd>
    </div>
  );
}

/** Create or edit one rule. Validated here with the server's own check before it is sent. */
function RuleEditor(props: { rule: ForwardingRule | null; onClose: () => void; onSaved: (rule: ForwardingRule, created: boolean) => void }): React.JSX.Element {
  const auth = useAuth();
  const [form, setForm] = useState<ForwardingRuleForm>(() => (props.rule ? formFromRule(props.rule) : EMPTY_FORWARDING_RULE_FORM));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function update(changes: Partial<ForwardingRuleForm>): void {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const check = checkForwardingRule(fieldsFromForm(form));
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = props.rule ? await auth.client.updateForwardingRule(props.rule.id, check.fields) : await auth.client.createForwardingRule(check.fields);
      props.onSaved(saved, props.rule === null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the forwarding rule.');
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.rule ? 'Edit forwarding rule' : 'New forwarding rule'}</DialogTitle>
          <DialogDescription>Received mail that matches is copied to the addresses you list.</DialogDescription>
        </DialogHeader>

        <form aria-label="Forwarding rule" onSubmit={(event) => void onSubmit(event)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name" className="text-xs">
              Name
            </Label>
            <Input
              id="rule-name"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              maxLength={MAX_FORWARDING_RULE_NAME_LENGTH}
              placeholder="e.g. Vendor invoices"
              className="h-8 text-[13px] shadow-none"
            />
          </div>

          <fieldset className="space-y-3">
            <legend className="text-xs font-medium">Match mail</legend>
            <p className="text-xs text-muted-foreground">
              Fill in either or both. With both, mail must match both. Separate entries with new lines or commas. A domain matches exactly, not its subdomains.
            </p>
            <EntriesField id="rule-senders" label="From (domains or addresses)" placeholder="billing.example.com" value={form.senders} onChange={(senders) => update({ senders })} />
            <EntriesField
              id="rule-recipients"
              label="To or Cc (domains or addresses)"
              placeholder="invoices@yourdomain.com"
              value={form.recipients}
              onChange={(recipients) => update({ recipients })}
            />
          </fieldset>

          <EntriesField id="rule-forward-to" label="Forward to" placeholder="ops@example.com" value={form.forwardTo} onChange={(forwardTo) => update({ forwardTo })} />

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox id="rule-enabled" checked={form.enabled} onCheckedChange={(checked) => update({ enabled: checked === true })} />
              <Label htmlFor="rule-enabled" className="text-[13px] font-normal">
                Enabled
              </Label>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Checkbox id="rule-ignore-dmarc" checked={form.ignoreDmarcVerification} onCheckedChange={(checked) => update({ ignoreDmarcVerification: checked === true })} />
                <Label htmlFor="rule-ignore-dmarc" className="text-[13px] font-normal">
                  Forward even if the sender isn&rsquo;t verified (skip DMARC)
                </Label>
              </div>
              {form.ignoreDmarcVerification && (
                <p className="mt-1.5 ml-6 text-xs text-amber-700 dark:text-amber-400">
                  Anyone can fake a From address, so this rule will forward mail claiming to be from anyone it matches. Copies of unverified mail are marked &ldquo;(unverified)&rdquo;. Use it only for
                  senders whose domain has no DMARC record.
                </p>
              )}
            </div>
          </div>

          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? 'Saving…' : props.rule ? 'Save' : 'Create rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EntriesField(props: { id: string; label: string; placeholder: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id} className="text-xs">
        {props.label}
      </Label>
      <Textarea
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        rows={2}
        spellCheck={false}
        autoCapitalize="off"
        className="min-h-0 font-mono text-xs shadow-none"
      />
    </div>
  );
}

/** The list with `rule` replacing its namesake, or appended when new. */
function upsert(rules: readonly ForwardingRule[], rule: ForwardingRule): ForwardingRule[] {
  return rules.some((r) => r.id === rule.id) ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
}
