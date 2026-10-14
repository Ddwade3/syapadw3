/*
 * figma-qa.js — автоматическая проверка секции/экрана в Figma.
 *
 * Выполняется в контексте Figma Plugin API: через Claude Bridge (`run.sh figma-qa.js`,
 * скрипт = тело async-функции с `figma`) или через use_figma. Top-level await и `return`
 * в конце. Возвращает JSON-строку (как требует Bridge); use_figma её тоже принимает.
 * Через Bridge PNG снимать помощником snap(), EXPORT_PNG оставить false — base64
 * не влезет в лимит вывода ~64 КБ.
 *
 * Как запускать (Claude делает это сам на шаге 5 процесса `design`):
 *   1. Подставить id фрейма секции в ROOT_ID (или выделить фрейм в Figma и оставить '').
 *   2. Выполнить скрипт. Он возвращает JSON-отчёт:
 *      { verdict: 'PASS'|'FAIL', summary, issues: [{level, code, nodeId, name, msg, fix}], stats }
 *   3. Все issues с level 'FAIL' исправить до показа; 'WARN' — исправить или осознанно оставить;
 *      'INFO' — гигиена, по возможности.
 *   4. Отчёт сохранить в qa/<секция>-qa.json и передать критику вместе с PNG.
 *
 * Что проверяет (коды):
 *   overlap-text         FAIL  текст пересекает текст
 *   overlap              WARN  частичное пересечение элементов (без /abs в имени)
 *   out-of-bounds        FAIL/WARN элемент выходит за границы корневого фрейма / родителя
 *   contrast             FAIL  контраст текста к фону ниже WCAG AA (4.5:1 / 3:1 для крупного)
 *   contrast-check       WARN  фон сложный (фото/градиент) — проверить вручную
 *   font-too-small       FAIL  текст < 12px
 *   font-small           WARN  текст 12–13px (кроме caption/legal в имени)
 *   body-too-small       WARN  абзац (>120 символов) меньше 16px
 *   line-length          WARN  строка длиннее ~80 символов
 *   line-height          WARN  межстрочное текста < 1.3
 *   placeholder-text     FAIL  lorem ipsum / «Заголовок» / «Текст»
 *   duplicate-text       WARN  одинаковый текст (≥25 символов) в двух местах
 *   spacing-off-scale    WARN  отступ auto layout не из шкалы 4/8
 *   no-auto-layout       WARN  фрейм с ≥2 детьми без auto layout
 *   group-node           WARN  Group вместо Frame
 *   text-at-edge         WARN  текст ближе 8px к краю заполненного контейнера
 *   small-target         WARN  кнопка ниже 40px или уже 44px
 *   default-name         WARN  имя слоя по умолчанию (Frame 123)
 *   too-many-fonts       WARN  больше 2 гарнитур
 *   too-many-sizes       WARN  больше 6 размеров шрифта в секции
 *   text-no-style        INFO  текст без текстового стиля/переменной
 *   fill-no-style        INFO  заливка без стиля/переменной
 */

const ROOT_ID = ''            // id фрейма секции; '' = текущее выделение
const EXPORT_PNG = false      // true → в отчёт добавится png_base64 (PNG 2×); через Bridge не включать
const MAX_ISSUES = 150        // защита от обрезания вывода (~64 КБ в Bridge)
const SPACING_SCALE = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 96, 112, 120, 128, 160, 200, 240]
const MIN_FONT = 12
const SMALL_FONT = 14
const BODY_FONT = 16
const MAX_LINE_CHARS = 80
const MIN_BODY_LINE_HEIGHT = 1.3
const DUP_MIN_LEN = 25
const EDGE_GAP = 8
const MAX_FONT_FAMILIES = 2
const MAX_FONT_SIZES = 6

// ---------- корень ----------
let root = null
if (ROOT_ID) {
  root = await figma.getNodeByIdAsync(ROOT_ID)
} else {
  root = figma.currentPage.selection[0] || null
}
if (!root || !('findAll' in root)) {
  return { verdict: 'FAIL', error: 'Не найден корневой фрейм. Укажите ROOT_ID или выделите фрейм секции.' }
}

const issues = []
const push = (level, code, node, msg, fix) => {
  issues.push({ level, code, nodeId: node ? node.id : null, name: node ? node.name : null, msg, fix })
}

// ---------- утилиты ----------
const isMixed = v => v === figma.mixed
const clamp01 = v => Math.max(0, Math.min(1, v))
const toHex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
const lin = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const luminance = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
const contrast = (a, b) => {
  const la = luminance(a), lb = luminance(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
const composite = (fg, a, bg) => ({ r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) })
const r1 = v => Math.round(v * 100) / 100

const isVisibleChain = node => {
  let n = node
  while (n && n !== root) {
    if ('visible' in n && n.visible === false) return false
    if ('opacity' in n && n.opacity === 0) return false
    n = n.parent
  }
  return true
}
const box = node => ('absoluteBoundingBox' in node ? node.absoluteBoundingBox : null)
const intersectArea = (a, b) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}
const contains = (outer, inner, tol = 0.5) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol &&
  inner.x + inner.width <= outer.x + outer.width + tol &&
  inner.y + inner.height <= outer.y + outer.height + tol
const isAbs = node => (node.name || '').toLowerCase().includes('/abs') || ('layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE')
const hasAutoLayout = node => 'layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE'

// Верхняя видимая заливка узла: {kind:'solid', color, opacity} | {kind:'complex'} | {kind:'none'} | {kind:'mixed'}
const topFill = node => {
  if (!('fills' in node)) return { kind: 'none' }
  const fills = node.fills
  if (isMixed(fills)) return { kind: 'mixed' }
  if (!fills || !fills.length) return { kind: 'none' }
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i]
    if (p.visible === false) continue
    if (p.type === 'SOLID') {
      const op = (p.opacity == null ? 1 : p.opacity)
      if (op === 0) continue
      return { kind: 'solid', color: p.color, opacity: op }
    }
    return { kind: 'complex', type: p.type }
  }
  return { kind: 'none' }
}

// Фактический фон под узлом: сначала «нижние» соседи, перекрывающие узел, затем предки, затем фон страницы.
const effectiveBackground = node => {
  const nb = box(node)
  let acc = null // накопленный цвет сверху вниз: {color, alpha}
  const layer = f => {
    if (f.kind === 'complex' || f.kind === 'mixed') return 'complex'
    if (f.kind !== 'solid') return 'skip'
    if (!acc) acc = { color: f.color, alpha: f.opacity }
    else acc = { color: composite(acc.color, acc.alpha, f.color), alpha: acc.alpha + f.opacity * (1 - acc.alpha) }
    return acc.alpha >= 0.999 ? 'done' : 'more'
  }
  let n = node
  while (n && n !== root) {
    const parent = n.parent
    if (!parent || !('children' in parent)) break
    // соседи ниже по z-порядку (меньший индекс = ниже), пересекающие узел
    if (!hasAutoLayout(parent) && nb) {
      const idx = parent.children.indexOf(n)
      for (let i = idx - 1; i >= 0; i--) {
        const s = parent.children[i]
        if (!isVisibleChain(s) || s.type === 'TEXT') continue // текст не бывает фоном
        const sb = box(s)
        if (!sb || !contains(sb, nb, 1)) continue
        const r = layer(topFill(s))
        if (r === 'complex') return { kind: 'complex', nodeId: s.id, name: s.name }
        if (r === 'done') return { kind: 'solid', color: acc.color }
      }
    }
    // сам родитель
    const r = layer(topFill(parent))
    if (r === 'complex') return { kind: 'complex', nodeId: parent.id, name: parent.name }
    if (r === 'done') return { kind: 'solid', color: acc.color }
    n = parent
  }
  // корень
  const rr = layer(topFill(root))
  if (rr === 'complex') return { kind: 'complex', nodeId: root.id, name: root.name }
  if (rr === 'done') return { kind: 'solid', color: acc.color }
  // фон страницы
  const pb = figma.currentPage.backgrounds
  const pageSolid = pb && pb.length && pb[pb.length - 1].type === 'SOLID' ? pb[pb.length - 1].color : { r: 1, g: 1, b: 1 }
  const r2 = layer({ kind: 'solid', color: pageSolid, opacity: 1 })
  return { kind: 'solid', color: acc ? acc.color : pageSolid, note: r2 }
}

// ---------- обход ----------
const all = root.findAll(n => isVisibleChain(n))
const texts = all.filter(n => n.type === 'TEXT')
const containers = [root, ...all.filter(n => 'children' in n && n.children && n.children.length)]
const rootBox = box(root)

const stats = { nodes: all.length, texts: texts.length, fontFamilies: {}, fontSizes: {}, defaultNames: 0, noStyleText: 0, noStyleFill: 0 }

// ---------- 1. Наложения и выход за границы ----------
for (const c of containers) {
  const kids = c.children.filter(k => isVisibleChain(k) && box(k))
  const cb = box(c)
  // выход за границы
  if (cb) {
    for (const k of kids) {
      const kb = box(k)
      if (!contains(cb, kb, 1) && !isAbs(k)) {
        const outsideRoot = rootBox && !contains(rootBox, kb, 1)
        const level = c === root || outsideRoot ? 'FAIL' : 'WARN'
        push(level, 'out-of-bounds', k, `«${k.name}» выходит за границы «${c.name}»${outsideRoot ? ' и за границы секции' : ''}`, 'Вернуть элемент внутрь контейнера или расширить контейнер по сетке')
      }
    }
  }
  if (hasAutoLayout(c)) continue // auto layout не даёт пересечений, кроме абсолютных детей (их пропускаем)
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i], b = kids[j]
      if (isAbs(a) || isAbs(b)) continue
      const ab = box(a), bb = box(b)
      const area = intersectArea(ab, bb)
      if (area < 4) continue
      const bothText = a.type === 'TEXT' && b.type === 'TEXT'
      if (!bothText && (contains(ab, bb) || contains(bb, ab))) continue // вложенность (фон + контент) — нормально; для двух текстов — нет
      if (bothText) {
        push('FAIL', 'overlap-text', a, `Текст «${a.name}» пересекает текст «${b.name}» (${b.id})`, 'Развести по вертикали/горизонтали, собрать в auto layout с отступом из шкалы')
      } else {
        push('WARN', 'overlap', a, `«${a.name}» частично пересекает «${b.name}» (${b.id})`, 'Если наложение задумано — добавить /abs в имя; иначе развести')
      }
    }
  }
}

// ---------- 2. Текст: размер, контраст, длина строки, межстрочное, заглушки, повторы ----------
const seenText = new Map()
const placeholderRe = /lorem ipsum|^(заголовок|подзаголовок|текст|описание|heading|title|subtitle|text|button|label|кнопка)\s*\d*$/i
for (const t of texts) {
  const chars = t.characters || ''
  const nameL = (t.name || '').toLowerCase()
  const isCaption = /caption|legal|юр|мелк|подпись|hint|meta/.test(nameL)

  // сегменты (устойчиво к figma.mixed)
  let segs = []
  try {
    segs = t.getStyledTextSegments(['fontSize', 'fontName', 'fontWeight', 'lineHeight', 'fills'])
  } catch (e) {
    segs = []
  }
  if (!segs.length) {
    const fs = isMixed(t.fontSize) ? null : t.fontSize
    const fn = isMixed(t.fontName) ? null : t.fontName
    const fw = isMixed(t.fontWeight) ? null : t.fontWeight
    const lh = isMixed(t.lineHeight) ? null : t.lineHeight
    const fl = isMixed(t.fills) ? null : t.fills
    segs = [{ characters: chars, fontSize: fs, fontName: fn, fontWeight: fw, lineHeight: lh, fills: fl }]
  }

  const sizes = segs.map(s => s.fontSize).filter(v => typeof v === 'number')
  const minSize = sizes.length ? Math.min(...sizes) : null
  for (const s of segs) {
    if (s.fontName && s.fontName.family) stats.fontFamilies[s.fontName.family] = (stats.fontFamilies[s.fontName.family] || 0) + 1
    if (typeof s.fontSize === 'number') stats.fontSizes[Math.round(s.fontSize)] = (stats.fontSizes[Math.round(s.fontSize)] || 0) + 1
  }

  // заглушки
  if (placeholderRe.test(chars.trim())) {
    push('FAIL', 'placeholder-text', t, `Заглушка «${chars.trim().slice(0, 40)}»`, 'Поставить реальный текст из ТЗ или осмысленную заглушку по теме')
  }

  // размер
  if (minSize != null) {
    if (minSize < MIN_FONT) push('FAIL', 'font-too-small', t, `${r1(minSize)}px — меньше минимума ${MIN_FONT}px`, `Поднять до ≥ ${MIN_FONT}px (подписи) или ≥ ${SMALL_FONT}px (второстепенный текст)`)
    else if (minSize < SMALL_FONT && !isCaption) push('WARN', 'font-small', t, `${r1(minSize)}px — мелко для десктопа`, `Второстепенный текст ≥ ${SMALL_FONT}px; если это подпись/юридический текст — добавить caption/legal в имя слоя`)
    if (chars.length > 120 && minSize < BODY_FONT) push('WARN', 'body-too-small', t, `Абзац ${r1(minSize)}px`, `Основной текст ≥ ${BODY_FONT}px`)
  }

  // длина строки
  if (chars.length > 100 && minSize && 'width' in t) {
    const approxChars = t.width / (minSize * 0.52)
    if (approxChars > MAX_LINE_CHARS) push('WARN', 'line-length', t, `≈${Math.round(approxChars)} символов в строке`, `Сузить блок до ≈ ${Math.round(MAX_LINE_CHARS * 0.85 * minSize * 0.52)}px (45–75 символов)`)
  }

  // межстрочное (для абзацев)
  if (chars.length > 100) {
    for (const s of segs) {
      const lh = s.lineHeight
      if (!lh || !lh.unit || lh.unit === 'AUTO' || typeof s.fontSize !== 'number') continue
      const ratio = lh.unit === 'PERCENT' ? lh.value / 100 : lh.value / s.fontSize
      if (ratio < MIN_BODY_LINE_HEIGHT) { push('WARN', 'line-height', t, `Межстрочное ${r1(ratio)}`, 'Для текста 1.4–1.6'); break }
    }
  }

  // повторы
  const norm = chars.trim().toLowerCase().replace(/\s+/g, ' ')
  if (norm.length >= DUP_MIN_LEN) {
    if (seenText.has(norm)) {
      const first = seenText.get(norm)
      push('WARN', 'duplicate-text', t, `Тот же текст, что в «${first.name}» (${first.id}): «${norm.slice(0, 50)}…»`, 'Одна мысль — одно место. Убрать повтор или переформулировать под другую задачу')
    } else seenText.set(norm, t)
  }

  // контраст
  const bg = effectiveBackground(t)
  const fill = segs.map(s => s.fills).find(f => Array.isArray(f) && f.length)
  const tf = fill ? topFill({ fills: fill }) : { kind: 'none' }
  if (tf.kind === 'solid') {
    const nodeOp = 'opacity' in t ? t.opacity : 1
    const alpha = clamp01(tf.opacity * nodeOp)
    if (bg.kind === 'solid') {
      const fg = alpha < 1 ? composite(tf.color, alpha, bg.color) : tf.color
      const ratio = contrast(fg, bg.color)
      const weight = Math.max(...segs.map(s => (typeof s.fontWeight === 'number' ? s.fontWeight : 400)))
      const large = minSize != null && (minSize >= 24 || (minSize >= 18.5 && weight >= 700)) // WCAG: 18pt = 24px; 14pt bold ≈ 18.5px
      const need = large ? 3 : 4.5
      if (ratio < need) {
        push('FAIL', 'contrast', t, `${toHex(fg)} на ${toHex(bg.color)} = ${r1(ratio)}:1 (нужно ≥ ${need}:1)`, 'Затемнить/осветлить текст или фон до нормы; серый второстепенный текст на белом — не светлее #767676')
      }
    } else if (bg.kind === 'complex') {
      push('WARN', 'contrast-check', t, `Текст над ${bg.name || 'сложным фоном'} (${bg.nodeId}) — фото/градиент`, 'Проверить контраст в самой светлой и самой тёмной точке под текстом; при необходимости подложка или затемнение 40–60%')
    }
  }

  // стили
  const noStyle = (t.textStyleId === '' || isMixed(t.textStyleId)) && !(t.boundVariables && Object.keys(t.boundVariables).length)
  if (noStyle) stats.noStyleText++

  // текст у края заполненного контейнера
  const p = t.parent
  const pb = p && box(p), tb = box(t)
  if (pb && tb && p !== root && topFill(p).kind !== 'none') {
    const gaps = [tb.x - pb.x, tb.y - pb.y, pb.x + pb.width - (tb.x + tb.width), pb.y + pb.height - (tb.y + tb.height)]
    if (Math.min(...gaps) < EDGE_GAP && Math.min(...gaps) >= -1) {
      push('WARN', 'text-at-edge', t, `До края «${p.name}» ${r1(Math.min(...gaps))}px`, 'Внутренний отступ контейнера 16–24px')
    }
  }
}

// ---------- 3. Контейнеры: auto layout, шкала отступов, группы, имена, кнопки, заливки ----------
const defaultNameRe = /^(Frame|Rectangle|Group|Ellipse|Vector|Line|Polygon|Star|Image|Text|Component|Instance|Union|Subtract|Intersect|Exclude)\s*\d*$/
const btnRe = /button|btn|кнопк|cta/i
for (const n of [root, ...all]) {
  if (defaultNameRe.test(n.name || '')) {
    stats.defaultNames++
    if (stats.defaultNames <= 10) push('WARN', 'default-name', n, `Имя по умолчанию «${n.name}»`, 'Назвать по смыслу: Section / Hero / Content / Title')
  }
  if (n.type === 'GROUP' && n.children && n.children.length >= 2) {
    push('WARN', 'group-node', n, 'Group вместо Frame', 'Заменить на Frame с auto layout')
  }
  if ((n.type === 'FRAME' || n.type === 'COMPONENT') && n.children && n.children.filter(k => isVisibleChain(k)).length >= 2 && !hasAutoLayout(n) && !isAbs(n)) {
    push('WARN', 'no-auto-layout', n, `Фрейм «${n.name}» с ${n.children.length} детьми без auto layout`, 'Включить auto layout (direction, gap из шкалы, padding из шкалы) или добавить /abs в имя для осознанного наложения')
  }
  if (hasAutoLayout(n) && n.type !== 'INSTANCE') {
    const vals = { itemSpacing: n.itemSpacing, paddingTop: n.paddingTop, paddingRight: n.paddingRight, paddingBottom: n.paddingBottom, paddingLeft: n.paddingLeft }
    if (n.counterAxisSpacing != null) vals.counterAxisSpacing = n.counterAxisSpacing
    const bad = Object.entries(vals).filter(([k, v]) => typeof v === 'number' && !SPACING_SCALE.includes(Math.round(v * 100) / 100))
    if (bad.length) push('WARN', 'spacing-off-scale', n, bad.map(([k, v]) => `${k}=${r1(v)}`).join(', '), 'Значения только из шкалы 4/8: 4 8 12 16 20 24 32 40 48 64 80 96 128 160')
  }
  if ((n.type === 'FRAME' || n.type === 'INSTANCE' || n.type === 'COMPONENT') && btnRe.test(n.name || '') && 'height' in n) {
    if (n.height < 40 || n.width < 44) push('WARN', 'small-target', n, `${Math.round(n.width)}×${Math.round(n.height)}`, 'Кнопка 44–48 высотой, ≥ 44 шириной; иконка-кнопка 40–48')
  }
  if (n.type !== 'TEXT' && 'fills' in n && !isMixed(n.fills) && n.fills && n.fills.some(p => p.type === 'SOLID' && p.visible !== false)) {
    const styled = ('fillStyleId' in n && n.fillStyleId && !isMixed(n.fillStyleId)) || (n.boundVariables && n.boundVariables.fills && n.boundVariables.fills.length)
    const paintBound = n.fills.some(p => p.boundVariables && p.boundVariables.color)
    if (!styled && !paintBound) stats.noStyleFill++
  }
}
if (stats.defaultNames > 10) push('WARN', 'default-name', null, `Ещё ${stats.defaultNames - 10} слоёв с именами по умолчанию`, 'Переименовать')
if (stats.noStyleText) push('INFO', 'text-no-style', null, `${stats.noStyleText} текстовых слоёв без текстового стиля/переменной`, 'Привязать к стилям UI-кита')
if (stats.noStyleFill) push('INFO', 'fill-no-style', null, `${stats.noStyleFill} заливок без стиля/переменной`, 'Привязать цвета к переменным UI-кита')

// ---------- 4. Типографика в целом ----------
const families = Object.keys(stats.fontFamilies)
if (families.length > MAX_FONT_FAMILIES) push('WARN', 'too-many-fonts', null, `Гарнитур: ${families.join(', ')}`, `Не больше ${MAX_FONT_FAMILIES}: заголовочная + текстовая`)
const sizeList = Object.keys(stats.fontSizes).map(Number).sort((a, b) => a - b)
if (sizeList.length > MAX_FONT_SIZES) push('WARN', 'too-many-sizes', null, `Размеров шрифта: ${sizeList.join(', ')}`, 'Одна шкала (1.2/1.25/1.333), в секции ≤ 4 размеров')

// ---------- итог ----------
const order = { FAIL: 0, WARN: 1, INFO: 2 }
issues.sort((a, b) => order[a.level] - order[b.level])
const counts = { FAIL: 0, WARN: 0, INFO: 0 }
for (const i of issues) counts[i.level]++
const truncated = Math.max(0, issues.length - MAX_ISSUES)
const result = {
  verdict: counts.FAIL ? 'FAIL' : 'PASS',
  root: { id: root.id, name: root.name, width: rootBox ? Math.round(rootBox.width) : null, height: rootBox ? Math.round(rootBox.height) : null },
  summary: `FAIL ${counts.FAIL} · WARN ${counts.WARN} · INFO ${counts.INFO} · текстов ${stats.texts} · гарнитуры ${families.join(', ') || '—'} · размеры ${sizeList.join('/') || '—'}`,
  counts,
  truncated,
  issues: issues.slice(0, MAX_ISSUES),
  stats: { nodes: stats.nodes, texts: stats.texts, fontFamilies: stats.fontFamilies, fontSizes: stats.fontSizes },
}
if (EXPORT_PNG && 'exportAsync' in root) {
  const bytes = await root.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })
  result.png_base64 = figma.base64Encode(bytes)
}
return JSON.stringify(result)
