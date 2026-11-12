/* ============================================================
   RollBoard Studio · 快捷键引擎
   ------------------------------------------------------------
   · 键位来自配置（可在配置页改），而不是写死在业务代码里
   · 统一用 KeyboardEvent.code 作为匹配依据，物理键位与输入法无关
   · 支持 Shift/Ctrl/Alt 修饰键组合
   · 冒泡阶段拦截，避免和页面默认行为打架
   ============================================================ */
(function () {
  'use strict';

  /* 动作定义：id 是配置里用的键，label 是帮助面板里显示的名字 */
  const ACTIONS = [
    { id: 'play',        label: '播放 / 暂停',          group: '播放' },
    { id: 'next',        label: '下一步',                group: '播放' },
    { id: 'prev',        label: '上一步',                group: '播放' },
    { id: 'speedUp',     label: '加速一档',              group: '调节' },
    { id: 'speedDown',   label: '减速一档',              group: '调节' },
    { id: 'nextReveal',  label: '跳到下一个揭晓',        group: '跳转' },
    { id: 'prevReveal',  label: '跳到上一个揭晓',        group: '跳转' },
    { id: 'nextCeremony',label: '跳到下一个荣誉时刻',     group: '跳转' },
    { id: 'nextTeam',    label: '跳到下一支队伍',        group: '跳转' },
    { id: 'pure',        label: '纯净模式（只显示榜单）', group: '视图' },
    { id: 'reset',       label: '回到封榜瞬间',          group: '视图' },
    { id: 'end',         label: '直达最终榜单',          group: '视图' },
    { id: 'fullscreen',  label: '全屏',                  group: '视图' },
    { id: 'theme',       label: '切换深浅主题',          group: '视图' },
    { id: 'settings',    label: '打开 / 关闭设置',        group: '视图' },
    { id: 'help',        label: '快捷键帮助',            group: '视图' }
  ];

  const DEFAULT_KEYS = {
    play: 'Space',
    next: 'ArrowRight',
    prev: 'ArrowLeft',
    speedUp: 'Period',
    speedDown: 'Comma',
    nextReveal: 'ControlRight+ArrowRight',
    prevReveal: 'ControlRight+ArrowLeft',
    nextCeremony: 'AltRight+ArrowRight',
    nextTeam: 'AltRight+ArrowDown',
    pure: 'KeyP',
    reset: 'KeyR',
    end: 'KeyE',
    fullscreen: 'KeyF',
    theme: 'KeyT',
    settings: 'KeyS',
    help: 'KeyH'
  };

  /** 把 KeyboardEvent 规范化成 "Ctrl+Shift+KeyX" 这种字符串 */
  function comboOf(e) {
    const parts = [];
    // 左/右修饰键统一成同一个名字，避免左右手不同导致配置不匹配
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(e.code);
    return parts.join('+');
  }

  /** 把配置里写的键位串也归一化，保证两边能对上 */
  function normalizeCombo(combo) {
    if (!combo) return null;
    const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
    const mods = [];
    let code = '';
    for (const p of parts) {
      if (p === 'Ctrl' || p === 'Control' || p === 'ControlLeft' || p === 'ControlRight' || p === 'Meta') {
        if (!mods.includes('Ctrl')) mods.push('Ctrl');
      } else if (p === 'Alt' || p === 'AltLeft' || p === 'AltRight') {
        if (!mods.includes('Alt')) mods.push('Alt');
      } else if (p === 'Shift' || p === 'ShiftLeft' || p === 'ShiftRight') {
        if (!mods.includes('Shift')) mods.push('Shift');
      } else {
        code = p;
      }
    }
    const order = ['Ctrl', 'Alt', 'Shift'];
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return mods.concat(code).join('+');
  }

  /** 人类可读的键名 */
  const KEY_LABEL = {
    Space: '空格', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓',
    Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'",
    Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    Backquote: '`', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫',
    ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    AltLeft: 'Alt', AltRight: 'Alt', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn'
  };
  function labelOf(combo) {
    if (!combo) return '—';
    return combo.split('+').map((p) => {
      if (p === 'Ctrl') return 'Ctrl';
      if (p === 'Alt') return 'Alt';
      if (p === 'Shift') return 'Shift';
      if (KEY_LABEL[p]) return KEY_LABEL[p];
      if (p.startsWith('Key')) return p.slice(3);
      if (p.startsWith('Digit')) return p.slice(5);
      if (p.startsWith('Numpad')) return '小键盘 ' + p.slice(6);
      return p;
    }).join(' + ');
  }

  /**
   * 快捷键引擎
   * @param {object} opts.keys    键位映射 { actionId: combo }
   * @param {function} opts.onAction (actionId, event) => void
   * @param {function} opts.isLocked  返回 true 时忽略所有快捷键（例如弹出层打开时）
   */
  function create(opts) {
    const o = opts || {};
    let keys = Object.assign({}, DEFAULT_KEYS, o.keys || {});
    const handlers = Object.create(null);
    let locked = false;

    function setKeys(next) {
      const merged = Object.assign({}, DEFAULT_KEYS, next || {});
      const out = {};
      for (const k of Object.keys(merged)) {
        const n = normalizeCombo(merged[k]);
        if (n) out[k] = n;
      }
      keys = out;
    }
    setKeys(o.keys);

    function getKeys() { return Object.assign({}, keys); }

    function on(actionId, fn) { handlers[actionId] = fn; }

    function comboFor(actionId) { return keys[actionId] || null; }

    function handle(e) {
      if (locked || (o.isLocked && o.isLocked())) return;
      if (e.defaultPrevented) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const combo = comboOf(e);
      for (const actionId of Object.keys(keys)) {
        if (keys[actionId] !== combo) continue;
        const fn = handlers[actionId];
        if (!fn) continue;
        e.preventDefault();
        e.stopPropagation();
        fn(e);
        return;
      }
    }

    function attach(target) {
      (target || document).addEventListener('keydown', handle);
    }
    function detach(target) {
      (target || document).removeEventListener('keydown', handle);
    }

    return {
      ACTIONS, DEFAULT_KEYS,
      on, attach, detach, setKeys, getKeys, comboFor,
      labelOf, comboOf,
      setLocked: (v) => { locked = !!v; },
      isLocked: () => locked
    };
  }

  window.RollKeys = {
    create, ACTIONS, DEFAULT_KEYS, labelOf, comboOf, normalizeCombo
  };
})();
