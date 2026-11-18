const SB = 0xff01;
const SC = 0xff02;
const START = 0x80;
const INTERNAL = 1;
const FAST = 2;
const SERIAL_IRQ = 8;
const SERIAL_RECEIVED = 0xffcc;
const SERIAL_SEND = 0xffcf;
const WAIT_FOR_BYTE = 0x073a;
const LINK_FRAME_WAITS = new Set([0x0826, 0x084a, 0x0855]);
const TRADE_SAVE_BANK = 0x0a;
const TRADE_SAVE_RETURN = 0x4dc3;
const BYTE_TIMEOUT_MS = 5000;

// The host checks the ROM digest and both players' receptionist readiness
// before attaching. Each end runs its own cartridge and SRAM.
export function attachLinkSerial(core, { role, send, onError, onTradeSaved }) {
  if (!core.cGBC || core.linkSerial || !['master', 'external'].includes(role)) {
    throw new Error('Link serial attachment is unavailable');
  }
  const master = role === 'master';
  const bindings = [
    [core.memoryReader, SB], [core.memoryReader, SC],
    [core.memoryHighReader, 1], [core.memoryHighReader, 2],
    [core.memoryWriter, SB], [core.memoryWriter, SC],
    [core.memoryHighWriter, 1], [core.memoryHighWriter, 2],
  ].map(([table, address]) => [table, address, table[address]]);
  let stopped = false;
  let bootstrapping = true;
  let waiting = false;
  let saveMarkerSeen = false;
  let counting = 0;
  let received = 0;
  let bitPeriod = 0;
  let nextSequence = 0;
  let controlSequence = -1;
  let pending = null;
  let deadline;

  const registerMode = () => core.memory[SC] & (START | INTERNAL);
  const hold = () => { core.stopEmulator |= 1; };

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadline);
    core.linkSerial = null;
    core.serialTimer = core.serialShiftTimer = 0;
    core.memory[SC] &= ~START;
    for (const [table, address, original] of bindings) table[address] = original;
  }

  function fail(reason) {
    if (stopped) return;
    stop();
    hold();
    queueMicrotask(() => onError(new Error(reason)));
  }

  function transmit(packet) {
    try {
      send(packet);
      return true;
    } catch {
      fail('Serial data channel is unavailable');
      return false;
    }
  }

  function watchDeadline() {
    clearTimeout(deadline);
    deadline = setTimeout(() => fail('Serial byte transfer timed out'), BYTE_TIMEOUT_MS);
  }

  function begin(byte, period) {
    clearTimeout(deadline);
    pending = null;
    nextSequence++;
    received = byte;
    bitPeriod = period;
    counting = 8;
    core.serialTimer = period * 8;
    core.serialShiftTimer = period;
    if (core.halt && (core.interruptsEnabled & SERIAL_IRQ)) {
      core.remainingClocks = Math.min(core.remainingClocks, core.serialTimer);
    }
    bootstrapping = false;
    waiting = false;
  }

  function replyWhenArmed() {
    if (!pending || counting || registerMode() !== START) return;
    if (pending.sync && (core.programCounter !== WAIT_FOR_BYTE || core.interruptsEnabled !== SERIAL_IRQ)) return;
    const { seq, byte, period, sync } = pending;
    if (bootstrapping && (byte !== 1 || core.memory[SB] !== 2)) {
      return fail('Trade receptionist clock roles did not match');
    }
    if (transmit({ type: 'serial-reply', seq, byte: core.memory[sync ? SERIAL_SEND : SB] })) {
      begin(byte, period << core.doubleSpeedShifter);
    }
  }

  function writeControl(data) {
    core.memory[SC] = data & (START | INTERNAL | FAST);
    core.serialTimer = core.serialShiftTimer = 0;
    counting = 0;
    if ((data & START) === 0) return;
    if (data & INTERNAL) {
      if (!master || pending || (bootstrapping && core.memory[SB] !== 1)) {
        return fail('Unexpected serial clock master');
      }
      const clocks = data & FAST ? 16 : 512;
      pending = { type: 'serial-offer', seq: nextSequence, byte: core.memory[SB],
        period: clocks >> core.doubleSpeedShifter };
      // The SC writer runs while the LDH operand is still the current byte.
      if (core.programCounter + 1 === WAIT_FOR_BYTE && core.interruptsEnabled === SERIAL_IRQ) {
        pending.sync = true;
        pending.byte = core.memory[SERIAL_SEND];
      }
      waiting = true;
      hold();
      watchDeadline();
      transmit(pending);
    } else if (!master) {
      if (bootstrapping) {
        waiting = true;
        hold();
      }
      replyWhenArmed();
    }
  }

  function receive(packet) {
    if (stopped || !packet || !['serial-offer', 'serial-reply'].includes(packet.type)) return;
    if (packet.seq !== nextSequence || !Number.isInteger(packet.byte) || packet.byte < 0 || packet.byte > 255) {
      return fail('Unexpected serial packet sequence or byte');
    }
    if (master && packet.type === 'serial-reply' && pending) {
      if (bootstrapping && packet.byte !== 2) return fail('Trade receptionist reply did not match');
      begin(packet.byte, pending.period << core.doubleSpeedShifter);
    } else if (!master && packet.type === 'serial-offer' && !pending &&
      [8, 16, 256, 512].includes(packet.period) && (packet.sync === undefined || packet.sync === true)) {
      pending = packet;
      watchDeadline();
      replyWhenArmed();
    } else {
      fail('Unexpected serial packet role');
    }
  }

  function advance(cycles) {
    if (!counting) return;
    core.serialTimer = Math.max(0, core.serialTimer - cycles);
    core.serialShiftTimer -= cycles;
    while (counting && core.serialShiftTimer <= 0) {
      core.serialShiftTimer += bitPeriod;
      const bit = (received >> (--counting)) & 1;
      core.memory[SB] = ((core.memory[SB] << 1) | bit) & 255;
    }
    if (counting === 0) {
      core.memory[SC] &= ~START;
      core.serialTimer = 0;
      core.interruptsRequested |= SERIAL_IRQ;
      core.checkIRQMatching();
    }
  }

  function beforeInstruction() {
    const saveMarker = core.ROMBank1offs === TRADE_SAVE_BANK && core.programCounter === TRADE_SAVE_RETURN;
    if (saveMarker && !saveMarkerSeen && onTradeSaved) {
      saveMarkerSeen = true;
      queueMicrotask(onTradeSaved);
    }
    if (!saveMarker) saveMarkerSeen = false;
    // The receiving game must not run through a link-wait frame faster
    // than the remote clock master can deliver that frame's transfer.
    if (!master && !bootstrapping && registerMode() === START &&
      LINK_FRAME_WAITS.has(core.programCounter)) {
      if (nextSequence === controlSequence) {
        waiting = true;
        return false;
      }
      controlSequence = nextSequence;
    }
    if (!master && !counting && registerMode() === START && core.programCounter === WAIT_FOR_BYTE &&
      !core.memory[SERIAL_RECEIVED] && !(core.interruptsRequested & SERIAL_IRQ)) {
      replyWhenArmed();
      if (counting) return true;
      waiting = true;
      return false;
    }
    return true;
  }

  core.serialTimer = core.serialShiftTimer = 0;
  core.memoryReader[SB] = core.memoryHighReader[1] = () => core.memory[SB];
  core.memoryReader[SC] = core.memoryHighReader[2] = () => 0x7c | core.memory[SC];
  core.memoryWriter[SB] = core.memoryHighWriter[1] = (_core, _address, byte) => { core.memory[SB] = byte; };
  core.memoryWriter[SC] = core.memoryHighWriter[2] = (_core, _address, byte) => writeControl(byte);
  core.linkSerial = { advance, beforeInstruction };
  if (!master && registerMode() === START && core.memory[SB] === 2) waiting = true;

  return {
    receive,
    canRun: () => !stopped && !waiting,
    stop,
  };
}
