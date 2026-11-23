import { TICKET_TRANSITIONS, type TicketState } from '@nt/shared';
import { fail } from './errors.js';

/** TICKET_TRANSITIONS 以外の遷移を拒否する（P1 から引き継ぎ） */
export function assertTransition(from: TicketState, to: TicketState): void {
  if (!TICKET_TRANSITIONS[from].includes(to)) fail('failed-precondition', 'invalidState');
}
