/* ============================================================
   iCost Sync — App Logic
   ============================================================
   Flow:
   1. Upload two iCost export files (xlsx/csv)
   2. Select which account each person uses for the other
   3. Compare: find transactions involving the other person's account
      that aren't matched
   4. Transform types for the debtor:
      - Original Transfer/Lend TO debtor's account → becomes Expense for debtor
      - Original Expense FROM debtor's account → becomes Transfer for debtor
   5. Let user select category (for expenses) or source account (for transfers)
   6. Export as iCost-importable CSV
   ============================================================ */

// ---- State ----
const state = {
    dataA: null,
    dataB: null,
    nameA: '',
    nameB: '',
    accountAforB: '',  // account in A's data that represents B
    accountBforA: '',  // account in B's data that represents A
    missingA: [],      // transformed records A needs to add
    missingB: [],      // transformed records B needs to add
    matched: [],
    
    // Splitter state
    splitterOwner: 'A',
    splitterData: [], // parsed PDF data
    categories: [], // Shared extracted categories for dropdowns
};

// ---- CSV Parsing ----
function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    let headerLine = lines[0];
    if (headerLine.charCodeAt(0) === 0xFEFF) headerLine = headerLine.slice(1);
    const headers = parseCSVLine(headerLine);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        const row = {};
        headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || '').trim(); });
        rows.push(row);
    }
    return rows;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = false;
            } else current += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { result.push(current); current = ''; }
            else current += ch;
        }
    }
    result.push(current);
    return result;
}

// ---- Flexible field accessors ----
function getField(row, ...keys) {
    for (const k of keys) {
        if (row[k] !== undefined && row[k] !== '') return String(row[k]);
    }
    return '';
}

function getDate(row)      { return getField(row, 'Date', '日期', 'Time', '时间'); }
function getType(row)      { return getField(row, 'Type', '类型', 'Category', '收支类型'); }
function getAmount(row)    {
    const v = getField(row, 'Amount', '金额', '金额（元）', '金额(元)') || '0';
    return Math.abs(parseFloat(v));
}
function getPrimary(row)   { return getField(row, 'First-Level Category', '一级分类', '分类', 'Basic Category', '类别'); }
function getSecondary(row) { return getField(row, 'Second-Level Category', '二级分类', '子分类', 'Secondary Category', '子类别'); }
function getAccount1(row)  { return getField(row, 'Account 1', '账户1', '账户', 'Account', '资产账户'); }
function getAccount2(row)  { return getField(row, 'Account 2', '账户2', 'Account2', '转入账户'); }
function getRemark(row)    { return getField(row, 'Remark', '备注', 'Note', 'Notes', '说明'); }
function getCurrency(row)  { return getField(row, 'Currency', '货币', '币种') || 'MXN'; }
function getTag(row)       { return getField(row, 'Tag', '标签', 'Tags', 'Label'); }

// ---- Account helpers ----
function getAccounts(data) {
    const accounts = new Set();
    data.forEach(row => {
        const a1 = getAccount1(row);
        const a2 = getAccount2(row);
        if (a1) accounts.add(a1);
        if (a2) accounts.add(a2);
    });
    return [...accounts].sort();
}

// Get unique categories from data: { primaries: [...], secondaryMap: { primary: [...] } }
function getCategories(data) {
    const primaries = new Set();
    const secondaryMap = {};

    data.forEach(row => {
        const p = getPrimary(row);
        const s = getSecondary(row);
        if (p) {
            primaries.add(p);
            if (!secondaryMap[p]) secondaryMap[p] = new Set();
            if (s) secondaryMap[p].add(s);
        }
    });

    // Convert sets to sorted arrays
    const result = {
        primaries: [...primaries].sort(),
        secondaryMap: {},
    };
    for (const [key, val] of Object.entries(secondaryMap)) {
        result.secondaryMap[key] = [...val].sort();
    }
    return result;
}

function normalizeDate(dateStr) {
    const m = dateStr.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    return dateStr.slice(0, 10);
}

// ---- Type helpers ----
function isExpense(row) {
    const t = getType(row);
    return t === '支出' || t === 'Expense' || t === 'expense';
}

function isTwoAccountTransaction(row) {
    const t = getType(row);
    const twoAcctTypes = [
        '转账', 'Transfer', 'transfer',
        'Lend', 'lend', 'Borrow', 'borrow',
        'Repayment', 'repayment', 'Collect', 'collect',
        'Transfer (Discount)', 'Repayment (Discount)', '借出优惠',
    ];
    return twoAcctTypes.includes(t) || (getAccount2(row) !== '');
}

// ---- Get all transactions involving a specific account ----
function getTransactionsForAccount(data, accountName) {
    return data.filter(row => {
        if (isExpense(row) && getAccount1(row) === accountName) return true;
        if (isTwoAccountTransaction(row)) {
            if (getAccount1(row) === accountName || getAccount2(row) === accountName) return true;
        }
        return false;
    });
}

// ---- Determine what type this record becomes for the DEBTOR ----
// If A did a Transfer/Lend TO B's account → For B it's an EXPENSE
// If A did an Expense FROM B's account → For B it's a TRANSFER
function determineDebtorType(originalRow, otherPersonAccount) {
    if (isExpense(originalRow) && getAccount1(originalRow) === otherPersonAccount) {
        // A spent from B's account → B needs to register a Transfer
        return 'transfer';
    }
    if (isTwoAccountTransaction(originalRow)) {
        // A transferred to/from B's account → B needs to register an Expense
        return 'expense';
    }
    return 'expense'; // default
}

// ---- Compare logic ----
function compareData() {
    const { dataA, dataB, accountAforB, accountBforA } = state;
    const minDateStr = $('#filter-date').value || '1900-01-01';

    let txnsAinvolvingB = getTransactionsForAccount(dataA, accountAforB);
    let txnsBinvolvingA = getTransactionsForAccount(dataB, accountBforA);

    // Apply date filter
    txnsAinvolvingB = txnsAinvolvingB.filter(row => normalizeDate(getDate(row)) >= minDateStr);
    txnsBinvolvingA = txnsBinvolvingA.filter(row => normalizeDate(getDate(row)) >= minDateStr);

    const poolB = [...txnsBinvolvingA];
    const poolA = [...txnsAinvolvingB];

    // Find A's transactions involving B that B doesn't have
    const missingInB = [];
    const matchedFromA = [];

    txnsAinvolvingB.forEach(rowA => {
        const dateA = normalizeDate(getDate(rowA));
        const amtA = getAmount(rowA);

        const matchIdx = poolB.findIndex(rowB => {
            const dateB = normalizeDate(getDate(rowB));
            const amtB = getAmount(rowB);
            return dateA === dateB && Math.abs(amtA - amtB) < 0.02;
        });

        if (matchIdx >= 0) {
            matchedFromA.push({ a: rowA, b: poolB[matchIdx] });
            poolB.splice(matchIdx, 1);
        } else {
            missingInB.push(rowA);
        }
    });

    // Find B's transactions involving A that A doesn't have
    const missingInA = [];
    const matchedFromB = [];

    txnsBinvolvingA.forEach(rowB => {
        const dateB = normalizeDate(getDate(rowB));
        const amtB = getAmount(rowB);

        const matchIdx = poolA.findIndex(rowA => {
            const dateA = normalizeDate(getDate(rowA));
            const amtA = getAmount(rowA);
            return dateA === dateB && Math.abs(amtA - amtB) < 0.02;
        });

        if (matchIdx >= 0) {
            matchedFromB.push({ a: poolA[matchIdx], b: rowB });
            poolA.splice(matchIdx, 1);
        } else {
            missingInA.push(rowB);
        }
    });

    // Transform: determine what type each missing record should be for the debtor
    state.missingA = missingInA.map(row => ({
        original: row,
        debtorType: determineDebtorType(row, accountBforA),
        selectedAccount: '',
        selectedCategory: '',
        selectedSubcategory: '',
        editedRemark: getRemark(row),
    }));

    state.missingB = missingInB.map(row => ({
        original: row,
        debtorType: determineDebtorType(row, accountAforB),
        selectedAccount: '',
        selectedCategory: '',
        selectedSubcategory: '',
        editedRemark: getRemark(row),
    }));

    state.matched = [...matchedFromA, ...matchedFromB];
}

// ---- Generate iCost import CSV ----
function generateImportCSV(missingItems, otherPersonAccount) {
    const headers = ['日期','类型','金额','一级分类','二级分类','账户1','账户2','备注','货币','标签'];
    const lines = [headers.join(',')];

    missingItems.forEach(item => {
        const row = item.original;
        const date = getDate(row);
        const amount = getAmount(row);
        const remark = item.editedRemark !== undefined ? item.editedRemark : getRemark(row);
        const currency = getCurrency(row).replace('$', '');
        const tag = getTag(row);

        if (item.debtorType === 'expense') {
            const category = item.selectedCategory || getPrimary(row) || 'Otro';
            const subcategory = item.selectedSubcategory || '';
            lines.push([
                date,
                '支出',
                amount,
                csvEscape(category),
                csvEscape(subcategory),
                csvEscape(otherPersonAccount),
                '',
                csvEscape(remark),
                currency,
                tag
            ].join(','));
        } else {
            const sourceAccount = item.selectedAccount || '';
            lines.push([
                date,
                '转账',
                amount,
                '',
                '',
                csvEscape(sourceAccount),
                csvEscape(otherPersonAccount),
                csvEscape(remark),
                currency,
                tag
            ].join(','));
        }
    });

    return '\uFEFF' + lines.join('\n');
}

function csvEscape(str) {
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// ---- UI Helpers ----
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function showStep(stepId) {
    $$('.step').forEach(s => s.classList.add('hidden'));
    $(`#${stepId}`).classList.remove('hidden');
    $(`#${stepId}`).style.animation = 'none';
    $(`#${stepId}`).offsetHeight;
    $(`#${stepId}`).style.animation = 'fadeInUp 0.5s ease';
}

function updateNames() {
    state.nameA = $('#name-a').value || 'Persona A';
    state.nameB = $('#name-b').value || 'Persona B';
    $$('.person-a-name').forEach(el => el.textContent = state.nameA);
    $$('.person-b-name').forEach(el => el.textContent = state.nameB);
}

function checkReadyForConfig() {
    if (state.dataA && state.dataB) {
        updateNames();
        populateAccountSelects();
        showStep('step-config');
    }
}

function populateAccountSelects() {
    const accountsA = getAccounts(state.dataA);
    const accountsB = getAccounts(state.dataB);

    const selA = $('#account-a-for-b');
    const selB = $('#account-b-for-a');

    selA.innerHTML = '<option value="">— Selecciona cuenta —</option>';
    selB.innerHTML = '<option value="">— Selecciona cuenta —</option>';

    accountsA.forEach(a => { selA.innerHTML += `<option value="${a}">${a}</option>`; });
    accountsB.forEach(a => { selB.innerHTML += `<option value="${a}">${a}</option>`; });
}

function updateAccountPreview(selectId, data, previewId) {
    const sel = $(`#${selectId}`);
    const preview = $(`#${previewId}`);
    const account = sel.value;

    if (account) {
        const count = getTransactionsForAccount(data, account).length;
        preview.querySelector('.preview-count').textContent = count;
        preview.classList.remove('hidden');
    } else {
        preview.classList.add('hidden');
    }
    checkCompareReady();
}

function checkCompareReady() {
    const a = $('#account-a-for-b').value;
    const b = $('#account-b-for-a').value;
    $('#btn-compare').disabled = !(a && b);
}

// ---- Build account options HTML for dropdowns in the table ----
function buildAccountOptions(accounts, selected) {
    let html = '<option value="">— Elegir cuenta —</option>';
    accounts.forEach(a => {
        html += `<option value="${a}" ${a === selected ? 'selected' : ''}>${a}</option>`;
    });
    return html;
}

// ---- Render Results ----
function renderResults() {
    const { missingA, missingB, matched } = state;

    $('#badge-a').textContent = missingA.length;
    $('#badge-b').textContent = missingB.length;
    $('#badge-matched').textContent = matched.length;

    renderMissingTable('table-missing-a', missingA, 'a');
    toggleEmpty('panel-missing-a', missingA.length === 0);
    $('#export-a').disabled = missingA.length === 0;

    renderMissingTable('table-missing-b', missingB, 'b');
    toggleEmpty('panel-missing-b', missingB.length === 0);
    $('#export-b').disabled = missingB.length === 0;

    renderMatchedTable(matched);
    toggleEmpty('panel-matched', matched.length === 0);
}

function renderMissingTable(tableId, items, person) {
    const tbody = $(`#${tableId} tbody`);
    tbody.innerHTML = '';

    const debtorData = person === 'a' ? state.dataA : state.dataB;
    const debtorAccounts = getAccounts(debtorData);
    const categories = getCategories(debtorData);

    items.forEach((item, idx) => {
        const row = item.original;
        const tr = document.createElement('tr');

        const isExp = item.debtorType === 'expense';
        const typeBadge = isExp
            ? '<span class="category-badge">Gasto</span>'
            : '<span class="category-badge transfer-badge">Transferencia</span>';

        // Primary category / Account column
        let primaryHtml = '';
        let secondaryHtml = '';

        if (isExp) {
            // Primary category dropdown
            const origCat = getPrimary(row);
            const selCat = item.selectedCategory || origCat || '';
            let opts = '<option value="">— Categoría —</option>';
            categories.primaries.forEach(c => {
                opts += `<option value="${c}" ${c === selCat ? 'selected' : ''}>${c}</option>`;
            });
            // Add original if not in list
            if (origCat && !categories.primaries.includes(origCat)) {
                opts += `<option value="${origCat}" selected>${origCat}</option>`;
            }
            primaryHtml = `<select class="inline-select category-input"
                data-idx="${idx}" data-person="${person}">${opts}</select>`;

            // Secondary category dropdown
            const subs = categories.secondaryMap[selCat] || [];
            const origSub = getSecondary(row);
            const selSub = item.selectedSubcategory || '';
            let subOpts = '<option value="">— Ninguna —</option>';
            subs.forEach(s => {
                subOpts += `<option value="${s}" ${s === selSub ? 'selected' : ''}>${s}</option>`;
            });
            if (origSub && !subs.includes(origSub)) {
                subOpts += `<option value="${origSub}" ${origSub === selSub ? 'selected' : ''}>${origSub}</option>`;
            }
            secondaryHtml = `<select class="inline-select subcategory-input"
                data-idx="${idx}" data-person="${person}">${subOpts}</select>`;
        } else {
            // Transfer: source account dropdown
            primaryHtml = `<select class="inline-select account-input"
                data-idx="${idx}" data-person="${person}">
                ${buildAccountOptions(debtorAccounts, item.selectedAccount)}
            </select>`;
            secondaryHtml = '<span class="text-muted">—</span>';
        }

        const origAccount = isTwoAccountTransaction(row)
            ? `${getAccount1(row)} → ${getAccount2(row)}`
            : getAccount1(row);

        const remarkValue = item.editedRemark || getRemark(row) || '';
        const remarkHtml = `<input type="text" class="inline-input remark-input"
            data-idx="${idx}" data-person="${person}"
            value="${remarkValue.replace(/"/g, '&quot;')}"
            placeholder="Agregar nota...">`;

        tr.innerHTML = `
            <td><input type="checkbox" checked data-idx="${idx}"></td>
            <td>${formatDate(getDate(row))}</td>
            <td class="amount-cell">$${getAmount(row).toLocaleString('es-MX', {minimumFractionDigits: 2})}</td>
            <td>${typeBadge}</td>
            <td>${primaryHtml}</td>
            <td>${secondaryHtml}</td>
            <td>${remarkHtml}</td>
            <td class="orig-account-cell">${origAccount}</td>
        `;
        tbody.appendChild(tr);
    });

    // Event: primary category change
    tbody.querySelectorAll('.category-input').forEach(select => {
        select.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx);
            const p = e.target.dataset.person;
            const list = p === 'a' ? state.missingA : state.missingB;
            list[idx].selectedCategory = e.target.value;
            list[idx].selectedSubcategory = '';  // reset sub

            // Update secondary dropdown with matching subcategories
            const data = p === 'a' ? state.dataA : state.dataB;
            const cats = getCategories(data);
            const subs = cats.secondaryMap[e.target.value] || [];
            const subSelect = e.target.closest('tr').querySelector('.subcategory-input');
            if (subSelect) {
                let subOpts = '<option value="">— Ninguna —</option>';
                subs.forEach(s => { subOpts += `<option value="${s}">${s}</option>`; });
                subSelect.innerHTML = subOpts;
            }
        });
    });

    // Event: subcategory change
    tbody.querySelectorAll('.subcategory-input').forEach(select => {
        select.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx);
            const p = e.target.dataset.person;
            const list = p === 'a' ? state.missingA : state.missingB;
            list[idx].selectedSubcategory = e.target.value;
        });
    });

    // Event: account change
    tbody.querySelectorAll('.account-input').forEach(select => {
        select.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx);
            const p = e.target.dataset.person;
            const list = p === 'a' ? state.missingA : state.missingB;
            list[idx].selectedAccount = e.target.value;
        });
    });

    // Event: remark change
    tbody.querySelectorAll('.remark-input').forEach(input => {
        input.addEventListener('input', e => {
            const idx = parseInt(e.target.dataset.idx);
            const p = e.target.dataset.person;
            const list = p === 'a' ? state.missingA : state.missingB;
            list[idx].editedRemark = e.target.value;
        });
    });
}

function renderMatchedTable(rows) {
    const tbody = $('#table-matched tbody');
    tbody.innerHTML = '';
    rows.forEach(({ a, b }) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDate(getDate(a))}</td>
            <td class="amount-cell">$${getAmount(a).toLocaleString('es-MX', {minimumFractionDigits: 2})}</td>
            <td><span class="category-badge">${getPrimary(a)}${getSecondary(a) ? ' / ' + getSecondary(a) : ''}</span></td>
            <td>${getRemark(a) || '—'}</td>
            <td>${getRemark(b) || '—'}</td>
        `;
        tbody.appendChild(tr);
    });
}

function toggleEmpty(panelId, isEmpty) {
    const panel = $(`#${panelId}`);
    const tableWrap = panel.querySelector('.results-table-wrap');
    const emptyMsg = panel.querySelector('.empty-message');
    const actions = panel.querySelector('.panel-actions');

    if (isEmpty) {
        if (tableWrap) tableWrap.style.display = 'none';
        if (emptyMsg) emptyMsg.classList.remove('hidden');
        if (actions) actions.style.display = 'none';
    } else {
        if (tableWrap) tableWrap.style.display = '';
        if (emptyMsg) emptyMsg.classList.add('hidden');
        if (actions) actions.style.display = '';
    }
}

function formatDate(dateStr) {
    const m = dateStr.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
    if (m) {
        const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        return `${parseInt(m[3])}/${months[parseInt(m[2])-1]}/${m[1]}`;
    }
    return dateStr;
}

function getSelectedIndices(tableId) {
    const checkboxes = $$(`#${tableId} tbody input[type="checkbox"]`);
    const indices = [];
    checkboxes.forEach(cb => {
        if (cb.checked) indices.push(parseInt(cb.dataset.idx));
    });
    return indices;
}

function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// ---- File handling ----
function setupDropZone(dropzoneId, fileInputId, browseButtonId, onLoaded) {
    const zone = $(`#${dropzoneId}`);
    const input = $(`#${fileInputId}`);
    const browseBtn = $(`#${browseButtonId}`);

    ['dragenter', 'dragover'].forEach(evt => {
        zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('dragover'); });
    });

    zone.addEventListener('drop', e => {
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file, zone, onLoaded);
    });

    browseBtn.addEventListener('click', e => {
        e.stopPropagation();
        input.click();
    });

    input.addEventListener('change', () => {
        if (input.files.length) handleFile(input.files[0], zone, onLoaded);
    });
}

function handleFile(file, zone, callback) {
    const isXlsx = /\.xlsx?$/i.test(file.name);

    if (isXlsx) {
        const reader = new FileReader();
        reader.onload = e => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            const normalized = rows.map(row => {
                const obj = {};
                Object.keys(row).forEach(key => {
                    obj[key.trim()] = String(row[key] ?? '').trim();
                });
                return obj;
            });
            updateDropZoneUI(zone, file, normalized);
            callback(normalized);
        };
        reader.readAsArrayBuffer(file);
    } else {
        const reader = new FileReader();
        reader.onload = e => {
            const rows = parseCSV(e.target.result);
            updateDropZoneUI(zone, file, rows);
            callback(rows);
        };
        reader.readAsText(file, 'UTF-8');
    }
}

function updateDropZoneUI(zone, file, rows) {
    zone.classList.add('loaded');
    zone.querySelector('.drop-content').classList.add('hidden');
    const success = zone.querySelector('.drop-success');
    success.classList.remove('hidden');
    success.querySelector('.file-name').textContent = file.name;
    success.querySelector('.file-rows').textContent = `${rows.length} registros`;
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
    setupDropZone('dropzone-a', 'file-a', 'browse-a', rows => {
        state.dataA = rows;
        console.log('Person A types:', [...new Set(rows.map(r => getType(r)))]);
        checkReadyForConfig();
    });

    setupDropZone('dropzone-b', 'file-b', 'browse-b', rows => {
        state.dataB = rows;
        console.log('Person B types:', [...new Set(rows.map(r => getType(r)))]);
        checkReadyForConfig();
    });

    $('#name-a').addEventListener('input', updateNames);
    $('#name-b').addEventListener('input', updateNames);

    $('#account-a-for-b').addEventListener('change', () => {
        state.accountAforB = $('#account-a-for-b').value;
        updateAccountPreview('account-a-for-b', state.dataA, 'preview-a');
    });

    $('#account-b-for-a').addEventListener('change', () => {
        state.accountBforA = $('#account-b-for-a').value;
        updateAccountPreview('account-b-for-a', state.dataB, 'preview-b');
    });

    $('#btn-compare').addEventListener('click', () => {
        updateNames();
        compareData();
        renderResults();
        showStep('step-results');
    });

    $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            $$('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const tabId = tab.dataset.tab;
            $$('.results-panel').forEach(p => p.classList.add('hidden'));
            $(`#panel-${tabId}`).classList.remove('hidden');
        });
    });

    $('#select-all-a').addEventListener('change', e => {
        $$('#table-missing-a tbody input[type="checkbox"]').forEach(cb => cb.checked = e.target.checked);
    });
    $('#select-all-b').addEventListener('change', e => {
        $$('#table-missing-b tbody input[type="checkbox"]').forEach(cb => cb.checked = e.target.checked);
    });

    $('#export-a').addEventListener('click', () => {
        const indices = getSelectedIndices('table-missing-a');
        const selected = indices.map(i => state.missingA[i]);
        const csv = generateImportCSV(selected, state.accountAforB);
        downloadCSV(csv, `faltantes_${state.nameA}.csv`);
    });

    $('#export-b').addEventListener('click', () => {
        const indices = getSelectedIndices('table-missing-b');
        const selected = indices.map(i => state.missingB[i]);
        const csv = generateImportCSV(selected, state.accountBforA);
        downloadCSV(csv, `faltantes_${state.nameB}.csv`);
    });

    $('#btn-reset').addEventListener('click', () => location.reload());

    // ---- Splitter Logic ----

    // Navigation
    $$('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const viewId = btn.dataset.view;
            $$('.view-section').forEach(v => v.classList.add('hidden'));
            $(`#view-${viewId}`).classList.remove('hidden');
        });
    });

    // PDF Upload
    const dropzonePdf = $('#dropzone-pdf');
    const filePdf = $('#file-pdf');
    const browsePdf = $('#browse-pdf');

    ['dragenter', 'dragover'].forEach(evt => {
        dropzonePdf.addEventListener(evt, e => { e.preventDefault(); dropzonePdf.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(evt => {
        dropzonePdf.addEventListener(evt, e => { e.preventDefault(); dropzonePdf.classList.remove('dragover'); });
    });

    dropzonePdf.addEventListener('drop', e => {
        const file = e.dataTransfer.files[0];
        if (file) handlePdfFile(file);
    });
    browsePdf.addEventListener('click', e => {
        e.stopPropagation();
        filePdf.click();
    });
    filePdf.addEventListener('change', () => {
        if (filePdf.files.length) handlePdfFile(filePdf.files[0]);
    });

    async function handlePdfFile(file) {
        if (!file.name.toLowerCase().endsWith('.pdf')) {
            alert("Por favor, sube un archivo PDF.");
            return;
        }

        const formData = new FormData();
        formData.append("file", file);

        const dropContent = dropzonePdf.querySelector('.drop-content');
        const dropLoading = dropzonePdf.querySelector('.drop-loading');
        const dropSuccess = dropzonePdf.querySelector('.drop-success');

        dropContent.classList.add('hidden');
        dropSuccess.classList.add('hidden');
        dropLoading.classList.remove('hidden');

        try {
            const response = await fetch('https://i-cost-sync.vercel.app/parse-pdf', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error("Error en el servidor al procesar el PDF");
            
            const json = await response.json();
            
            if (!json.transactions || json.transactions.length === 0) {
                throw new Error("No se encontraron gastos en el archivo.");
            }

            // Add split state to transactions
            state.splitterData = json.transactions.map(t => ({
                ...t,
                splitType: '5050', // '5050', 'mine', 'hers', 'manual'
                amountMine: t.amount / 2,
                amountHers: t.amount / 2,
                category: 'Comida', // Default
                subcategory: ''
            }));

            dropLoading.classList.add('hidden');
            dropSuccess.classList.remove('hidden');
            dropSuccess.querySelector('.file-name').textContent = file.name;
            dropSuccess.querySelector('.file-rows').textContent = `${state.splitterData.length} gastos extraídos`;
            
            // Populate categories if we have data from sync step, else fallback
            let rawCats = null;
            if (state.dataA) rawCats = getCategories(state.dataA);
            else if (state.dataB) rawCats = getCategories(state.dataB);

            if (rawCats) {
                state.categories = rawCats.primaries.map(p => ({
                    primary: p,
                    secondaries: rawCats.secondaryMap[p] || []
                }));
            }

            renderSplitterTable();
            
            $('#splitter-step-upload').classList.add('hidden');
            $('#splitter-step-results').classList.remove('hidden');

        } catch (err) {
            alert("Error: " + err.message);
            dropLoading.classList.add('hidden');
            dropContent.classList.remove('hidden');
        }
    }

    function renderSplitterTable() {
        const tbody = $('#table-splitter tbody');
        tbody.innerHTML = '';

        state.splitterData.forEach((item, index) => {
            const tr = document.createElement('tr');
            
            // Date cell
            const tdDate = document.createElement('td');
            tdDate.setAttribute('data-label', 'FECHA');
            tdDate.textContent = item.date;
            
            // Amount cell
            const tdAmount = document.createElement('td');
            tdAmount.setAttribute('data-label', 'MONTO');
            tdAmount.className = 'amount-cell';
            tdAmount.textContent = `$${item.amount.toFixed(2)}`;
            
            // Concept cell
            const tdConcept = document.createElement('td');
            tdConcept.setAttribute('data-label', 'CONCEPTO');
            tdConcept.className = 'remark-cell';
            tdConcept.title = item.description;
            tdConcept.textContent = item.description;
            
            // Split Control cell
            const tdSplit = document.createElement('td');
            tdSplit.setAttribute('data-label', 'DIVISIÓN');
            tdSplit.innerHTML = `
                <div class="split-controls">
                    <button class="split-btn ${item.splitType === '5050' ? 'active' : ''}" data-idx="${index}" data-type="5050">50/50</button>
                    <button class="split-btn ${item.splitType === 'mine' ? 'active' : ''}" data-idx="${index}" data-type="mine">Mío</button>
                    <button class="split-btn ${item.splitType === 'hers' ? 'active' : ''}" data-idx="${index}" data-type="hers">Ella</button>
                    <button class="split-btn ${item.splitType === 'manual' ? 'active' : ''}" data-idx="${index}" data-type="manual">Manual</button>
                </div>
                <div class="custom-amounts ${item.splitType === 'manual' ? '' : 'hidden'}" id="custom-amt-${index}">
                    <div class="amount-input-group">
                        <span>Mío $</span>
                        <input type="number" step="0.01" class="amt-mine" data-idx="${index}" value="${item.amountMine.toFixed(2)}">
                    </div>
                    <div class="amount-input-group">
                        <span>Ella $</span>
                        <input type="number" step="0.01" class="amt-hers" data-idx="${index}" value="${item.amountHers.toFixed(2)}">
                    </div>
                </div>
            `;
            
            // Attach split button listeners
            tdSplit.querySelectorAll('.split-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const type = e.target.dataset.type;
                    item.splitType = type;
                    if (type === '5050') { item.amountMine = item.amount / 2; item.amountHers = item.amount / 2; }
                    else if (type === 'mine') { item.amountMine = item.amount; item.amountHers = 0; }
                    else if (type === 'hers') { item.amountMine = 0; item.amountHers = item.amount; }
                    
                    if (type === 'manual') {
                        tdSplit.querySelector('.custom-amounts').classList.remove('hidden');
                    } else {
                        tdSplit.querySelector('.custom-amounts').classList.add('hidden');
                        // Update inputs
                        tdSplit.querySelector('.amt-mine').value = item.amountMine.toFixed(2);
                        tdSplit.querySelector('.amt-hers').value = item.amountHers.toFixed(2);
                    }
                    
                    tdSplit.querySelectorAll('.split-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                });
            });
            
            // Attach manual input listeners
            tdSplit.querySelectorAll('input[type="number"]').forEach(input => {
                input.addEventListener('change', (e) => {
                    const isMine = e.target.classList.contains('amt-mine');
                    let val = parseFloat(e.target.value) || 0;
                    
                    if (isMine) {
                        item.amountMine = val;
                        item.amountHers = Math.max(0, item.amount - val);
                        tdSplit.querySelector('.amt-hers').value = item.amountHers.toFixed(2);
                    } else {
                        item.amountHers = val;
                        item.amountMine = Math.max(0, item.amount - val);
                        tdSplit.querySelector('.amt-mine').value = item.amountMine.toFixed(2);
                    }
                });
            });
            
            // Primary Category
            const tdCat = document.createElement('td');
            tdCat.setAttribute('data-label', 'CATEGORÍA');
            const inpCat = document.createElement('input');
            inpCat.type = 'text';
            inpCat.className = 'inline-input';
            inpCat.value = item.category;
            inpCat.placeholder = "Escribe...";
            
            const listCatId = `cat-list-${index}`;
            inpCat.setAttribute('list', listCatId);
            const dlCat = document.createElement('datalist');
            dlCat.id = listCatId;

            let categories = state.categories.length ? state.categories : [
                { primary: 'Comida', secondaries: [] },
                { primary: 'Compras', secondaries: [] },
                { primary: 'Transporte', secondaries: [] },
                { primary: 'Vida', secondaries: [] }
            ];
            categories.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.primary;
                dlCat.appendChild(opt);
            });
            
            // Subcategory
            const tdSub = document.createElement('td');
            tdSub.setAttribute('data-label', 'SUBCATEGORÍA');
            const inpSub = document.createElement('input');
            inpSub.type = 'text';
            inpSub.className = 'inline-input';
            inpSub.value = item.subcategory;
            inpSub.placeholder = "Opcional...";
            
            const listSubId = `subcat-list-${index}`;
            inpSub.setAttribute('list', listSubId);
            const dlSub = document.createElement('datalist');
            dlSub.id = listSubId;
            
            const updateSubcategories = (primaryCat) => {
                dlSub.innerHTML = '';
                const catObj = categories.find(c => c.primary === primaryCat);
                if (catObj && catObj.secondaries.length > 0) {
                    catObj.secondaries.forEach(sub => {
                        const opt = document.createElement('option');
                        opt.value = sub;
                        dlSub.appendChild(opt);
                    });
                }
            };
            
            // Populate subcategories for the default primary category immediately
            updateSubcategories(item.category);
            
            inpCat.addEventListener('change', e => {
                item.category = e.target.value.trim();
                // Only reset subcategory if primary changed
                updateSubcategories(item.category);
            });
            inpSub.addEventListener('change', e => {
                item.subcategory = e.target.value.trim();
            });
            
            updateSubcategories(item.category);
            tdCat.appendChild(inpCat);
            tdCat.appendChild(dlCat);
            tdSub.appendChild(inpSub);
            tdSub.appendChild(dlSub);
            
            tr.appendChild(tdDate);
            tr.appendChild(tdAmount);
            tr.appendChild(tdConcept);
            tr.appendChild(tdSplit);
            tr.appendChild(tdCat);
            tr.appendChild(tdSub);
            
            tbody.appendChild(tr);
        });
    }

    $('#export-split').addEventListener('click', () => {
        state.splitterOwner = $('#splitter-owner').value;
        
        if (!state.accountAforB && state.splitterOwner === 'A') {
            const userInp = prompt("Ingresa el nombre exacto de la cuenta que usas en iCost para representar a tu novia:");
            if (!userInp) return;
            state.accountAforB = userInp.trim();
        }
        
        const lines = [];
        lines.push(['日期', '类型', '金额', '一级分类', '二级分类', '账户1', '账户2', '备注', '货币', '标签'].join(','));
        
        state.splitterData.forEach(item => {
            const dateStr = item.date + ' 12:00:00';
            
            if (state.splitterOwner === 'A') {
                if (item.amountMine > 0) {
                    lines.push([
                        dateStr, '支出', item.amountMine.toFixed(2),
                        csvEscape(item.category), csvEscape(item.subcategory),
                        '', '', csvEscape(item.description), '', ''
                    ].join(','));
                }
                if (item.amountHers > 0) {
                    lines.push([
                        dateStr, '转账', item.amountHers.toFixed(2),
                        '', '', '', csvEscape(state.accountAforB),
                        csvEscape(item.description), '', ''
                    ].join(','));
                }
            } else {
                if (item.amountMine > 0) {
                    lines.push([
                        dateStr, '支出', item.amountMine.toFixed(2),
                        csvEscape(item.category), csvEscape(item.subcategory),
                        csvEscape(state.accountAforB), '', csvEscape(item.description), '', ''
                    ].join(','));
                }
            }
        });

        const csvContent = lines.join('\n');
        downloadCSV(csvContent, 'gastos_divididos_banorte.csv');
    });

    $('#btn-reset-splitter').addEventListener('click', () => {
        state.splitterData = [];
        $('#splitter-step-results').classList.add('hidden');
        $('#splitter-step-upload').classList.remove('hidden');
        $('#dropzone-pdf').querySelector('.drop-success').classList.add('hidden');
        $('#dropzone-pdf').querySelector('.drop-content').classList.remove('hidden');
    });
});
