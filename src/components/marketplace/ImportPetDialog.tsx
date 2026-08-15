import { FolderOpen, Upload, X } from 'lucide-react';
import { useState } from 'react';

import { petsApi, type InstalledPet, type PetFileDraft } from './marketplace-api';

/**
 * The import flow.
 *
 * Two ways in, because pets arrive two ways. A pet installed by Codex is
 * already a folder on disk, so pasting its path is the shortest route and
 * copies it into `~/.tails/pets` where it becomes editable and removable. A pet
 * that arrived as a download is loose files, so it gets picked and uploaded.
 *
 * A bare spritesheet with no `pet.json` is accepted too: the manifest is four
 * fields, and refusing to import artwork because it lacks a JSON file the user
 * would have to write by hand is a worse experience than asking for a name.
 */

type ImportPetDialogProps = {
  onClose: () => void;
  onImported: (pet: InstalledPet) => void;
};

/** Ids become directory names, so they are restricted to what the server will accept. */
const toId = (value: string): string => value
  .toLowerCase()
  .replace(/\.[a-z0-9]+$/, '')
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/^[^a-z0-9]+/, '')
  .slice(0, 64);

const readAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
  reader.readAsDataURL(file);
});

const readAsText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
  reader.readAsText(file);
});

const FIELD_CLASS = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm '
  + 'outline-none focus:ring-2 focus:ring-ring';

export function ImportPetDialog({ onClose, onImported }: ImportPetDialogProps) {
  const [folderPath, setFolderPath] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<PetFileDraft | null>(null);
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sorts the chosen files into "the manifest" and "the artwork".
   *
   * One picker rather than two, because the natural gesture is to select the
   * contents of a pet folder in one go and the file types are unambiguous.
   */
  const acceptFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);

    const chosenImage = [...files].find((file) => /\.(webp|png|gif|apng)$/i.test(file.name));
    const chosenManifest = [...files].find((file) => /\.json$/i.test(file.name));

    if (chosenImage) {
      setImageFile(chosenImage);
      if (!id) setId(toId(chosenImage.name));
      if (!displayName) setDisplayName(chosenImage.name.replace(/\.[a-z0-9]+$/i, ''));
    }

    if (!chosenManifest) return;

    try {
      const parsed = JSON.parse(await readAsText(chosenManifest)) as PetFileDraft;
      setManifest(parsed);
      if (parsed.id) setId(toId(parsed.id));
      if (parsed.displayName) setDisplayName(parsed.displayName);
      if (parsed.description) setDescription(parsed.description);
    } catch {
      setError(`${chosenManifest.name} is not valid JSON.`);
    }
  };

  const runImport = async (action: () => Promise<InstalledPet>) => {
    setBusy(true);
    setError(null);
    try {
      onImported(await action());
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'That import did not work.');
    } finally {
      setBusy(false);
    }
  };

  const importUpload = () => {
    if (!imageFile) {
      setError('Pick a spritesheet image to import.');
      return;
    }

    void runImport(async () => {
      const data = await readAsDataUrl(imageFile);
      const definition: PetFileDraft = {
        ...manifest,
        id: toId(id) || toId(imageFile.name),
        displayName: displayName.trim() || id,
        description: description.trim() || undefined,
        // Whatever the manifest claimed the sprite was called, the file the
        // user actually picked is the one being written.
        spritesheetPath: imageFile.name,
      };
      return petsApi.importUpload(definition, { fileName: imageFile.name, data });
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide">Import pet</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import"
            className="rounded-md p-1.5 text-muted-foreground transition-colors duration-quick hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {error ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <FolderOpen className="size-3.5" /> From a folder on this machine
            </h3>
            <p className="text-xs text-muted-foreground">
              Paste the path to a folder containing <code>pet.json</code>. It is copied into your
              own pets folder, so the original is left untouched.
            </p>
            <div className="flex gap-2">
              <input
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                placeholder="C:\Users\you\.codex\pets\sonic"
                aria-label="Pet folder path"
                className={FIELD_CLASS}
              />
              <button
                type="button"
                disabled={busy || !folderPath.trim()}
                onClick={() => void runImport(() => petsApi.importFromPath(folderPath.trim()))}
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
              >
                Import
              </button>
            </div>
          </section>

          <section className="space-y-2 border-t border-border pt-5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Upload className="size-3.5" /> From files
            </h3>
            <p className="text-xs text-muted-foreground">
              Choose a spritesheet, and its <code>pet.json</code> as well if you have one. Without a
              manifest the frame layout is inferred, and you can correct it afterwards.
            </p>

            <input
              type="file"
              multiple
              accept=".json,.webp,.png,.gif,.apng,image/*"
              onChange={(event) => void acceptFiles(event.target.files)}
              aria-label="Pet files"
              className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1.5 file:text-xs file:text-foreground hover:file:bg-accent"
            />

            {imageFile ? (
              <p className="text-xs text-muted-foreground">
                Sprite: <span className="text-foreground">{imageFile.name}</span>
                {manifest ? ' · manifest loaded' : ' · no manifest'}
              </p>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="block text-[11px] font-medium text-muted-foreground">Id</span>
                <input
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="sonic"
                  className={FIELD_CLASS}
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-muted-foreground">Name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Sonic"
                  className={FIELD_CLASS}
                />
              </label>
            </div>

            <label className="block">
              <span className="block text-[11px] font-medium text-muted-foreground">Description</span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="A tiny blue speedster."
                className={FIELD_CLASS}
              />
            </label>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={busy || !imageFile}
                onClick={importUpload}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95 disabled:opacity-50"
              >
                Import files
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
