import { useCallback, useState } from 'react';

import type { InstalledPet } from '@/components/marketplace';
import { hideDesktopPet, refreshDesktopPet } from '@/components/marketplace/desktop-pet';

import {
  activatePet,
  assignPetToSession,
  clearActivePet,
  readStage,
  savePetStage,
  savePetVoice,
  type PetStage,
  type PetVoice,
} from './chat-pet-api';
import { PetDetailsPanel } from './PetDetailsPanel';

/**
 * The pet's settings, openable from anywhere that has a pet.
 *
 * `PetDetailsPanel` is presentation: it is handed a stage and a pet and reports
 * changes. Everything around it — where the stage comes from, what saving means,
 * what "put him on the desktop" does to two different flags — lived inside
 * `ChatPet`, which meant the panel could only be opened by a pet who was
 * already standing in a conversation. That is exactly backwards for the pet the
 * user is most likely to want to configure: the one out on the desktop, who has
 * no in-chat component to open it from.
 *
 * So the plumbing moves here and the carousel can open the same panel the pill
 * does. One settings screen for a pet, not two that drift.
 */

type Props = {
  pet: InstalledPet;
  /** The conversation on screen, if there is one. Enables the dock button. */
  sessionId: string | null;
  /** True when this pet is already standing in that conversation. */
  inChat?: boolean;
  onClose: () => void;
  /** Something changed on the server; the opener should re-read its list. */
  onChanged?: () => void;
};

export function PetSettingsDialog({ pet, sessionId, inChat = false, onClose, onChanged }: Props) {
  /*
    Applied here and saved behind it. A size slider that waits for a round trip
    per step is a size slider nobody can aim, and the server clamps the same
    range this does — so the optimistic value and the stored one cannot
    disagree about anything the user can see.
  */
  const [stage, setStage] = useState<PetStage>(() => readStage(pet));

  const changeStage = useCallback((next: PetStage) => {
    setStage(next);
    void savePetStage(pet.definition.id, next).then(onChanged).catch(() => {
      // A failed save costs this setting, not the panel. The value on screen is
      // the value that was asked for, and re-opening will show the truth.
    });
  }, [pet.definition.id, onChanged]);

  const changeVoice = useCallback((voice: PetVoice | null) => {
    void savePetVoice(pet.definition.id, voice).then(onChanged).catch(() => {});
  }, [pet.definition.id, onChanged]);

  const sendToDesktop = useCallback(() => {
    /*
      Two flags, and both have to move. Activating decides *who* the desktop
      shows; the hide decides whether it shows anybody at all. Setting only the
      first is what left a pet who was active, correct, and invisible.
    */
    hideDesktopPet(false);
    void activatePet(pet.definition.id)
      .then(() => { refreshDesktopPet(); onChanged?.(); })
      .catch(() => {});
    onClose();
  }, [pet.definition.id, onChanged, onClose]);

  const sendToChat = useCallback(() => {
    if (!sessionId) return;
    void assignPetToSession(sessionId, pet.definition.id)
      .then(() => {
        // He is in a conversation now, so the desktop copy of him should not
        // also be standing outside it.
        if (pet.active) return clearActivePet(pet.definition.id).catch(() => {});
        return undefined;
      })
      .then(() => { refreshDesktopPet(); onChanged?.(); })
      .catch(() => {});
    onClose();
  }, [sessionId, pet.definition.id, pet.active, onChanged, onClose]);

  const hide = useCallback(() => {
    // "Hide him" from here means off the screen he is currently on. For a pet
    // on the desktop that is the desktop window; the assignment to a chat is a
    // different decision and is not touched.
    if (pet.active) {
      hideDesktopPet(true);
      void clearActivePet(pet.definition.id).then(() => { refreshDesktopPet(); onChanged?.(); }).catch(() => {});
    }
    onClose();
  }, [pet.active, pet.definition.id, onChanged, onClose]);

  return (
    <PetDetailsPanel
      pet={pet}
      stage={stage}
      onChange={changeStage}
      onChangeVoice={changeVoice}
      onClose={onClose}
      // Offered only when it would change something: a pet already on the
      // desktop has nowhere to be sent, and neither has one already in the chat.
      onSendToDesktop={pet.active ? undefined : sendToDesktop}
      onSendToChat={sessionId && !inChat ? sendToChat : undefined}
      onHide={hide}
    />
  );
}
