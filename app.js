(function () {
  'use strict';

  var CFG = window.ROYI_CONFIG || {};
  var MAX_ITEM_ROWS = 7; // B19:F25 共 7 列（品項＋規格每行＋以下空白）
  var DRAFT_STORAGE_KEY = 'royi_liff_saved_form_v1';

  var state = {
    mode: 'create', // 'create' | 'edit' | 'revise'
    no: '',
    nextVersion: '',
    quoteStatus: '',
    customers: [],
    itemSuggestions: [],
    defaultNotes: ['1.月結60天', '2.保固三年', '3.交貨時間為下單後一個月'],
    delivery: { type: 'none', value: '' },
    items: [{ name: '', qty: 1, price: '', specsText: '' }],
    originalSnapshot: null,
    allRecords: null,
    contextGroupId: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  function fmtMoney(n) { return (Number(n) || 0).toLocaleString('en-US'); }

  function excelUrlFromDraft(draftUrl) {
    var m = String(draftUrl || '').match(/\/d\/([\w-]+)/) || String(draftUrl || '').match(/[?&]id=([\w-]+)/);
    return m ? 'https://docs.google.com/spreadsheets/d/' + m[1] + '/export?format=xlsx' : '';
  }

  function showLoading(text) {
    $('loadingText').textContent = text || '載入中…';
    $('globalLoading').classList.remove('hidden');
  }
  function hideLoading() { $('globalLoading').classList.add('hidden'); }

  function showError(msg) {
    var el = $('globalError');
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function showNotice(msg) {
    var el = $('globalNotice');
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  /* ---------- JWT 過期檢查與表單暫存保護 ---------- */

  function isTokenNearExpiry(token) {
    if (!token) return true;
    try {
      var parts = token.split('.');
      if (parts.length < 2) return true;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      var now = Math.floor(Date.now() / 1000);
      return !payload.exp || payload.exp <= now + 30;
    } catch (e) {
      return false;
    }
  }

  function saveFormToSession() {
    try {
      var snap = {
        mode: state.mode,
        no: state.no,
        customer: $('customerSelect').value,
        newCustName: $('newCustName').value,
        newCustTaxId: $('newCustTaxId').value,
        newCustContact: $('newCustContact').value,
        newCustPhone: $('newCustPhone').value,
        newCustEmail: $('newCustEmail').value,
        newCustAddress: $('newCustAddress').value,
        delivery: state.delivery,
        items: collectItemsRaw(),
        notes: [$('note1').value, $('note2').value, $('note3').value],
        savedAt: Date.now()
      };
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(snap));
    } catch (e) { /* ignore storage quota */ }
  }

  function restoreFormFromSession() {
    try {
      var raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      var snap = JSON.parse(raw);
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
      if (!snap || (Date.now() - snap.savedAt) > 15 * 60 * 1000) return false;
      if (snap.mode !== state.mode || snap.no !== state.no) return false;

      $('customerSelect').value = snap.customer || '';
      toggleNewCustomerBox();
      $('newCustName').value = snap.newCustName || '';
      $('newCustTaxId').value = snap.newCustTaxId || '';
      $('newCustContact').value = snap.newCustContact || '';
      $('newCustPhone').value = snap.newCustPhone || '';
      $('newCustEmail').value = snap.newCustEmail || '';
      $('newCustAddress').value = snap.newCustAddress || '';
      setDeliveryUI(snap.delivery || { type: 'none', value: '' }, false);
      state.items = (snap.items && snap.items.length) ? snap.items : [{ name: '', qty: 1, price: '', specsText: '' }];
      renderItems();
      if (snap.notes) {
        $('note1').value = snap.notes[0] || '';
        $('note2').value = snap.notes[1] || '';
        $('note3').value = snap.notes[2] || '';
      }
      recalcTotalsAndRows();
      updateModifiedHighlights();
      showNotice('已為您重新驗證身分，並完整保留剛才填寫的表單內容，請直接點選送出。');
      return true;
    } catch (e) {
      return false;
    }
  }

  function reloginPreservingForm() {
    saveFormToSession();
    showLoading('登入憑證已過期，正在保留表單內容並重新驗證…');
    liff.login({ redirectUri: window.location.href });
  }

  async function callGas(action, payload, allowRetry) {
    if (allowRetry === undefined) allowRetry = true;
    var idToken = liff.getIDToken();
    if (!idToken || isTokenNearExpiry(idToken)) {
      reloginPreservingForm();
      throw new Error('TOKEN_REFRESHING');
    }

    var res = await fetch(CFG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, idToken: idToken, payload: payload || {} })
    });
    if (!res.ok) throw new Error('連線失敗（HTTP ' + res.status + '）');
    var data = await res.json();

    if (data && !data.ok && data.code === 'TOKEN_EXPIRED') {
      if (allowRetry) {
        // 先嘗試重抓一次 ID Token，若仍無效則保留表單並重新登入
        var fresh = liff.getIDToken();
        if (fresh && fresh !== idToken && !isTokenNearExpiry(fresh)) {
          return callGas(action, payload, false);
        }
        reloginPreservingForm();
        throw new Error('TOKEN_REFRESHING');
      }
      reloginPreservingForm();
      throw new Error('TOKEN_REFRESHING');
    }
    return data;
  }

  /* ---------- 分頁切換 ---------- */

  function switchTab(tab) {
    var isForm = tab === 'form';
    $('tabBtnForm').classList.toggle('active', isForm);
    $('tabBtnRecords').classList.toggle('active', !isForm);
    $('paneForm').classList.toggle('hidden', !isForm);
    $('paneRecords').classList.toggle('hidden', isForm);
    if (!isForm && !state.allRecords) loadRecords();
  }

  /* ---------- 模式橫幅 ---------- */

  function updateModeUI() {
    var banner = $('modeBanner');
    var submitBtn = $('btnSubmit');
    banner.className = 'mode-banner';
    $('sentBlockBanner').classList.add('hidden');
    submitBtn.disabled = false;

    if (state.mode === 'edit') {
      banner.classList.add('mode-edit');
      banner.textContent = '修改 ' + state.no;
      submitBtn.textContent = '儲存修改';
      if (state.quoteStatus === '已寄出') {
        $('sentBlockBanner').classList.remove('hidden');
        submitBtn.disabled = true;
      }
    } else if (state.mode === 'revise') {
      banner.classList.add('mode-revise');
      banner.textContent = '改版 ' + state.no + (state.nextVersion ? ' → ' + state.nextVersion : '');
      submitBtn.textContent = '建立改版草稿';
    } else {
      banner.classList.add('mode-create');
      banner.textContent = '新增報價';
      submitBtn.textContent = '建立報價單';
    }
  }

  /* ---------- 客戶與交期 ---------- */

  function renderCustomerOptions() {
    var sel = $('customerSelect');
    sel.innerHTML = '';
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '請選擇客戶…';
    sel.appendChild(opt0);

    state.customers.forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });

    var optNew = document.createElement('option');
    optNew.value = '__NEW__';
    optNew.textContent = '＋ 新客戶';
    sel.appendChild(optNew);
  }

  function renderItemSuggestions() {
    var dl = $('itemSuggestions');
    dl.innerHTML = '';
    state.itemSuggestions.forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      dl.appendChild(o);
    });
  }

  function toggleNewCustomerBox() {
    var isNew = $('customerSelect').value === '__NEW__';
    $('newCustomerBox').classList.toggle('hidden', !isNew);
  }

  function setDeliveryUI(delivery, updateNote3) {
    state.delivery = delivery || { type: 'none', value: '' };
    var chips = $('deliveryChips').querySelectorAll('.chip');
    chips.forEach(function (ch) {
      var pv = ch.getAttribute('data-preset');
      var active = (state.delivery.type === 'preset' && state.delivery.value === pv) ||
        (state.delivery.type === 'none' && pv === '');
      ch.classList.toggle('active', active);
    });
    $('deliveryDate').value = state.delivery.type === 'date' ? state.delivery.value : '';

    if (updateNote3) {
      if (state.delivery.type === 'date' && state.delivery.value) {
        $('note3').value = '3.交貨日期：' + state.delivery.value.replace(/-/g, '/');
      } else if (state.delivery.type === 'preset' && state.delivery.value) {
        $('note3').value = '3.交貨時間為下單後' + state.delivery.value;
      } else {
        $('note3').value = state.defaultNotes[2] || '3.交貨時間為下單後一個月';
      }
      updateModifiedHighlights();
    }
  }

  /* ---------- 品項動態表單與列數檢查 ---------- */

  function parseSpecsText(txt) {
    return String(txt || '').replace(/\r/g, '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function collectItemsRaw() {
    var cards = $('itemsContainer').querySelectorAll('.item-card');
    var out = [];
    cards.forEach(function (card) {
      out.push({
        name: card.querySelector('.it-name').value,
        qty: card.querySelector('.it-qty').value,
        price: card.querySelector('.it-price').value,
        specsText: card.querySelector('.it-specs').value
      });
    });
    return out;
  }

  function collectItemsForSubmit() {
    return collectItemsRaw().map(function (it) {
      return {
        name: it.name.trim(),
        qty: Number(it.qty),
        price: Number(it.price),
        specs: parseSpecsText(it.specsText)
      };
    });
  }

  function calcTotalRows(rawItems) {
    var total = 1; // 「以下空白」
    rawItems.forEach(function (it) {
      total += 1 + parseSpecsText(it.specsText).length;
    });
    return total;
  }

  function renderItems() {
    var box = $('itemsContainer');
    box.innerHTML = '';
    state.items.forEach(function (it, idx) {
      var card = document.createElement('div');
      card.className = 'item-card';
      card.setAttribute('data-idx', idx);
      card.innerHTML =
        '<div class="item-head">' +
          '<span>品項 #' + (idx + 1) + '</span>' +
          (state.items.length > 1 ? '<button type="button" class="btn btn-danger-text btn-del-item">刪除</button>' : '') +
        '</div>' +
        '<div class="field">' +
          '<label>品名 <span class="req">*</span></label>' +
          '<input type="text" list="itemSuggestions" class="input it-name" placeholder="輸入或選擇品名" />' +
          '<div class="field-error err-name"></div>' +
        '</div>' +
        '<div class="item-num-row">' +
          '<div class="field">' +
            '<label>數量 <span class="req">*</span></label>' +
            '<input type="number" min="1" step="any" inputmode="decimal" class="input it-qty" />' +
            '<div class="field-error err-qty"></div>' +
          '</div>' +
          '<div class="field">' +
            '<label>單價 <span class="req">*</span></label>' +
            '<input type="number" min="0" step="any" inputmode="decimal" class="input it-price" placeholder="未稅單價" />' +
            '<div class="field-error err-price"></div>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>規格（選填，一行一個規格）</label>' +
          '<textarea class="input it-specs" placeholder="例如：\n32GB\n1TB SSD"></textarea>' +
        '</div>';

      card.querySelector('.it-name').value = it.name || '';
      card.querySelector('.it-qty').value = it.qty !== undefined ? it.qty : 1;
      card.querySelector('.it-price').value = it.price !== undefined ? it.price : '';
      card.querySelector('.it-specs').value = it.specsText || '';

      var delBtn = card.querySelector('.btn-del-item');
      if (delBtn) {
        delBtn.addEventListener('click', function () {
          state.items = collectItemsRaw();
          state.items.splice(idx, 1);
          renderItems();
          recalcTotalsAndRows();
          updateModifiedHighlights();
        });
      }

      card.querySelectorAll('.input').forEach(function (inp) {
        inp.addEventListener('input', function () {
          recalcTotalsAndRows();
          updateModifiedHighlights();
        });
      });

      box.appendChild(card);
    });
    recalcTotalsAndRows();
    updateModifiedHighlights();
  }

  function recalcTotalsAndRows() {
    var raw = collectItemsRaw();
    var subtotal = 0;
    raw.forEach(function (it) {
      var q = Number(it.qty) || 0;
      var p = Number(it.price) || 0;
      if (q > 0 && p >= 0) subtotal += q * p;
    });
    var tax = Math.round(subtotal * 0.05);
    var total = subtotal + tax;
    $('sumSubtotal').textContent = fmtMoney(subtotal) + ' 元';
    $('sumTax').textContent = fmtMoney(tax) + ' 元';
    $('sumTotal').textContent = fmtMoney(total) + ' 元';

    var usedRows = calcTotalRows(raw);
    var counter = $('rowCounter');
    counter.textContent = '已用 ' + usedRows + ' / ' + MAX_ITEM_ROWS + ' 列';
    var over = usedRows > MAX_ITEM_ROWS;
    counter.classList.toggle('over', over);
    $('rowLimitError').textContent = over
      ? '已超過模板品項區上限（B19:F25 共 7 列，含規格每行與「以下空白」），請減少品項或規格行數後再送出。'
      : '';
    if (state.quoteStatus !== '已寄出' || state.mode !== 'edit') {
      $('btnSubmit').disabled = over;
    }
  }

  /* ---------- 修改欄位醒目標示（修改／改版模式） ---------- */

  function captureSnapshot() {
    return {
      customer: $('customerSelect').value,
      notes: [$('note1').value, $('note2').value, $('note3').value],
      items: collectItemsRaw()
    };
  }

  function updateModifiedHighlights() {
    var orig = state.originalSnapshot;
    if (!orig || state.mode === 'create') return;

    $('customerSelect').classList.toggle('is-modified', $('customerSelect').value !== orig.customer);
    ['note1', 'note2', 'note3'].forEach(function (id, i) {
      $(id).classList.toggle('is-modified', $(id).value !== (orig.notes[i] || ''));
    });

    var cards = $('itemsContainer').querySelectorAll('.item-card');
    cards.forEach(function (card, idx) {
      var o = orig.items[idx];
      var nEl = card.querySelector('.it-name');
      var qEl = card.querySelector('.it-qty');
      var pEl = card.querySelector('.it-price');
      var sEl = card.querySelector('.it-specs');
      var isNew = !o;
      var mName = isNew || nEl.value !== o.name;
      var mQty = isNew || String(qEl.value) !== String(o.qty);
      var mPrice = isNew || String(pEl.value) !== String(o.price);
      var mSpecs = isNew || sEl.value !== o.specsText;
      nEl.classList.toggle('is-modified', mName);
      qEl.classList.toggle('is-modified', mQty);
      pEl.classList.toggle('is-modified', mPrice);
      sEl.classList.toggle('is-modified', mSpecs);
      card.classList.toggle('is-modified', mName || mQty || mPrice || mSpecs);
    });
  }

  /* ---------- 送出驗證與處理 ---------- */

  function clearValidationErrors() {
    document.querySelectorAll('.field-error').forEach(function (el) {
      if (el.id !== 'rowLimitError') el.textContent = '';
    });
    document.querySelectorAll('.is-invalid').forEach(function (el) { el.classList.remove('is-invalid'); });
  }

  function validateForm() {
    clearValidationErrors();
    var ok = true;
    var firstBad = null;
    function fail(el, errEl, msg) {
      ok = false;
      if (el) el.classList.add('is-invalid');
      if (errEl) errEl.textContent = msg;
      if (!firstBad && el) firstBad = el;
    }

    var custVal = $('customerSelect').value;
    if (!custVal) {
      fail($('customerSelect'), $('errCustomer'), '請選擇客戶');
    } else if (custVal === '__NEW__') {
      if (!$('newCustName').value.trim()) fail($('newCustName'), $('errNewCustName'), '請輸入新客戶名稱');
      var tax = $('newCustTaxId').value.trim();
      if (!/^\d{1,8}$/.test(tax)) fail($('newCustTaxId'), $('errNewCustTaxId'), '請輸入數字統編（最多 8 碼）');
    }

    var rawItems = collectItemsRaw();
    if (calcTotalRows(rawItems) > MAX_ITEM_ROWS) {
      ok = false;
      $('rowLimitError').textContent = '已超過模板品項區上限（共 7 列，含規格與以下空白），無法送出。';
      if (!firstBad) firstBad = $('rowCounter');
    }

    var cards = $('itemsContainer').querySelectorAll('.item-card');
    cards.forEach(function (card) {
      var nEl = card.querySelector('.it-name');
      var qEl = card.querySelector('.it-qty');
      var pEl = card.querySelector('.it-price');
      if (!nEl.value.trim()) fail(nEl, card.querySelector('.err-name'), '請輸入品名');
      if (!(Number(qEl.value) > 0)) fail(qEl, card.querySelector('.err-qty'), '數量須大於 0');
      if (pEl.value === '' || isNaN(Number(pEl.value)) || Number(pEl.value) < 0) {
        fail(pEl, card.querySelector('.err-price'), '請輸入正確單價');
      }
    });

    if (firstBad && firstBad.scrollIntoView) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return ok;
  }

  async function onSubmitForm(e) {
    e.preventDefault();
    showError('');
    showNotice('');
    if (!validateForm()) return;

    var isNew = $('customerSelect').value === '__NEW__';
    var payload = {
      no: state.no,
      customer: isNew ? $('newCustName').value.trim() : $('customerSelect').value,
      taxId: isNew ? $('newCustTaxId').value.trim() : '',
      contact: isNew ? $('newCustContact').value.trim() : '',
      phone: isNew ? $('newCustPhone').value.trim() : '',
      email: isNew ? $('newCustEmail').value.trim() : '',
      address: isNew ? $('newCustAddress').value.trim() : '',
      delivery: state.delivery,
      items: collectItemsForSubmit(),
      notes: [$('note1').value.trim(), $('note2').value.trim(), $('note3').value.trim()].filter(Boolean)
    };

    var action = state.mode === 'edit' ? 'updateQuote' : (state.mode === 'revise' ? 'reviseQuote' : 'createQuote');
    var btn = $('btnSubmit');
    btn.disabled = true;
    showLoading('正在寫入 Google 試算表，請稍候…');

    try {
      var res = await callGas(action, payload);
      hideLoading();
      if (!res || !res.ok) {
        btn.disabled = false;
        showError((res && res.error) || '送出失敗，請稍後再試。');
        return;
      }

      // 顯示成功結果
      $('quoteForm').classList.add('hidden');
      $('resultCard').classList.remove('hidden');
      $('resultTitle').textContent = state.mode === 'edit' ? '已更新報價單' : (state.mode === 'revise' ? '已建立改版草稿' : '已建立草稿');
      $('resNo').textContent = res.quoteNo;
      $('resTotal').textContent = fmtMoney(res.total) + ' 元';
      $('resDraftLink').href = res.draftUrl;

      var remindEl = $('resultRemind');
      if (res.wasConfirmed) {
        remindEl.textContent = '⚠️ 原狀態為「已確認」，已重設為「草稿」。內容已更新，請重新確認產生 PDF！';
        remindEl.classList.remove('hidden');
      } else {
        remindEl.classList.add('hidden');
      }

      state.allRecords = null; // 讓紀錄分頁下次開啟重新載入（結果卡片已由 GAS 直接推送到群組）
    } catch (err) {
      hideLoading();
      if (err && err.message === 'TOKEN_REFRESHING') return;
      btn.disabled = false;
      showError('送出失敗：' + (err && err.message || err));
    }
  }

  /* ---------- 報價紀錄分頁 ---------- */

  async function loadRecords() {
    $('recordsStatus').textContent = '正在載入報價紀錄…';
    $('recordsList').innerHTML = '';
    try {
      var res = await callGas('listQuotes', {});
      if (!res || !res.ok) {
        $('recordsStatus').textContent = (res && res.error) || '讀取紀錄失敗';
        return;
      }
      state.allRecords = res.records || [];
      populateRecordFilters();
      renderRecords();
    } catch (err) {
      if (err && err.message === 'TOKEN_REFRESHING') return;
      $('recordsStatus').textContent = '讀取紀錄失敗：' + (err && err.message || err);
    }
  }

  function populateRecordFilters() {
    var custs = {};
    var months = {};
    (state.allRecords || []).forEach(function (r) {
      if (r.customer) custs[r.customer] = true;
      var m = String(r.date || '').slice(0, 7);
      if (/^\d{4}\/\d{2}$/.test(m)) months[m] = true;
    });

    var cSel = $('recFilterCustomer');
    cSel.innerHTML = '<option value="">全部客戶</option>';
    Object.keys(custs).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c; cSel.appendChild(o);
    });

    var mSel = $('recFilterMonth');
    mSel.innerHTML = '<option value="">全部月份</option>';
    Object.keys(months).sort().reverse().forEach(function (m) {
      var o = document.createElement('option');
      o.value = m; o.textContent = m; mSel.appendChild(o);
    });
  }

  function renderRecords() {
    var kw = $('recSearch').value.trim().toLowerCase();
    var fc = $('recFilterCustomer').value;
    var fm = $('recFilterMonth').value;
    var fs = $('recFilterStatus').value;

    var list = (state.allRecords || []).filter(function (r) {
      if (fc && r.customer !== fc) return false;
      if (fm && String(r.date || '').indexOf(fm) !== 0) return false;
      if (fs && r.status !== fs) return false;
      if (kw) {
        var hay = (String(r.no || '') + ' ' + String(r.customer || '')).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });

    $('recordsStatus').textContent = '顯示 ' + list.length + ' 筆（共 ' + (state.allRecords || []).length + ' 筆）';
    var box = $('recordsList');
    box.innerHTML = '';

    if (!list.length) {
      box.innerHTML = '<div class="card" style="text-align:center;color:#64748b;">沒有符合條件的報價單</div>';
      return;
    }

    list.forEach(function (r) {
      var card = document.createElement('div');
      var stCls = r.status === '已確認' ? 'status-confirmed' : (r.status === '已寄出' ? 'status-sent' : '');
      card.className = 'rec-card ' + stCls;

      var excelUrl = excelUrlFromDraft(r.draftUrl);
      var btnsHtml = '';
      if (r.status === '草稿') {
        if (r.draftUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + r.draftUrl + '" target="_blank" rel="noopener">開草稿</a>';
        if (excelUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + excelUrl + '" target="_blank" rel="noopener">下載 Excel</a>';
        btnsHtml += '<button type="button" class="btn btn-secondary btn-sm act-edit">用表單修改</button>';
        btnsHtml += '<button type="button" class="btn btn-primary btn-sm act-confirm">確認產生 PDF</button>';
      } else if (r.status === '已確認') {
        if (r.draftUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + r.draftUrl + '" target="_blank" rel="noopener">開草稿</a>';
        if (r.pdfUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + r.pdfUrl + '" target="_blank" rel="noopener">開 PDF</a>';
        if (excelUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + excelUrl + '" target="_blank" rel="noopener">下載 Excel</a>';
        btnsHtml += '<button type="button" class="btn btn-secondary btn-sm act-edit">用表單修改</button>';
        btnsHtml += '<button type="button" class="btn btn-primary btn-sm act-sent">已寄出</button>';
      } else {
        if (r.pdfUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + r.pdfUrl + '" target="_blank" rel="noopener">開 PDF</a>';
        if (excelUrl) btnsHtml += '<a class="btn btn-secondary btn-sm" href="' + excelUrl + '" target="_blank" rel="noopener">下載 Excel</a>';
        btnsHtml += '<button type="button" class="btn btn-primary btn-sm act-revise">改版</button>';
      }

      card.innerHTML =
        '<div class="rec-top">' +
          '<span class="rec-no">' + r.no + '</span>' +
          '<span class="status-pill">' + r.status + '</span>' +
        '</div>' +
        '<div class="rec-meta">' +
          '<div>客戶：<strong>' + r.customer + '</strong></div>' +
          '<div>日期：' + r.date + '　｜　含稅：<strong>' + fmtMoney(String(r.total).replace(/,/g, '')) + ' 元</strong></div>' +
          '<div>建立者：' + (r.creator || '—') + '</div>' +
        '</div>' +
        '<div class="rec-actions">' + btnsHtml + '</div>';

      var editBtn = card.querySelector('.act-edit');
      if (editBtn) editBtn.addEventListener('click', function () { openFormFor('edit', r.no); });
      var revBtn = card.querySelector('.act-revise');
      if (revBtn) revBtn.addEventListener('click', function () { openFormFor('revise', r.no); });
      var confBtn = card.querySelector('.act-confirm');
      if (confBtn) confBtn.addEventListener('click', function () { runRecordAction('confirmQuote', r.no, '確認產生 PDF'); });
      var sentBtn = card.querySelector('.act-sent');
      if (sentBtn) sentBtn.addEventListener('click', function () { runRecordAction('markSent', r.no, '標記已寄出'); });

      box.appendChild(card);
    });
  }

  async function runRecordAction(action, no, label) {
    if (!window.confirm('確定要對 ' + no + ' 執行「' + label + '」嗎？')) return;
    showLoading('正在執行「' + label + '」…');
    try {
      var res = await callGas(action, { no: no });
      hideLoading();
      window.alert((res && res.message) || (res && res.error) || '已完成');
      loadRecords();
    } catch (err) {
      hideLoading();
      if (err && err.message === 'TOKEN_REFRESHING') return;
      window.alert('執行失敗：' + (err && err.message || err));
    }
  }

  async function openFormFor(mode, no) {
    state.mode = mode;
    state.no = no;
    $('resultCard').classList.add('hidden');
    $('quoteForm').classList.remove('hidden');
    switchTab('form');
    showLoading('正在載入 ' + no + ' 資料…');
    try {
      var res = await callGas('init', { mode: mode, no: no });
      hideLoading();
      if (!res || !res.ok || !res.quote) {
        showError((res && res.error) || '無法載入報價單內容');
        return;
      }
      applyQuoteDetail(res.quote);
    } catch (err) {
      hideLoading();
      if (err && err.message === 'TOKEN_REFRESHING') return;
      showError('載入失敗：' + (err && err.message || err));
    }
  }

  function applyQuoteDetail(q) {
    state.quoteStatus = q.status || '';
    state.nextVersion = q.nextVersion || '';
    if (q.customer && state.customers.indexOf(q.customer) < 0) {
      state.customers.push(q.customer);
      renderCustomerOptions();
    }
    $('customerSelect').value = q.customer || '';
    toggleNewCustomerBox();

    state.items = (q.items && q.items.length)
      ? q.items.map(function (it) {
          return { name: it.name, qty: it.qty, price: it.price, specsText: (it.specs || []).join('\n') };
        })
      : [{ name: '', qty: 1, price: '', specsText: '' }];
    renderItems();

    var notes = q.notes || state.defaultNotes;
    $('note1').value = notes[0] || '';
    $('note2').value = notes[1] || '';
    $('note3').value = notes[2] || '';
    setDeliveryUI(q.delivery || { type: 'none', value: '' }, false);

    state.originalSnapshot = captureSnapshot();
    updateModeUI();
    recalcTotalsAndRows();
    updateModifiedHighlights();
  }

  function resetToCreateMode() {
    state.mode = 'create';
    state.no = '';
    state.quoteStatus = '';
    state.nextVersion = '';
    state.originalSnapshot = null;
    $('resultCard').classList.add('hidden');
    $('quoteForm').classList.remove('hidden');
    $('customerSelect').value = '';
    toggleNewCustomerBox();
    ['newCustName', 'newCustTaxId', 'newCustContact', 'newCustPhone', 'newCustEmail', 'newCustAddress'].forEach(function (id) {
      $(id).value = '';
    });
    state.items = [{ name: '', qty: 1, price: '', specsText: '' }];
    renderItems();
    $('note1').value = state.defaultNotes[0] || '';
    $('note2').value = state.defaultNotes[1] || '';
    $('note3').value = state.defaultNotes[2] || '';
    setDeliveryUI({ type: 'none', value: '' }, false);
    document.querySelectorAll('.is-modified').forEach(function (el) { el.classList.remove('is-modified'); });
    clearValidationErrors();
    updateModeUI();
  }

  /* ---------- 初始化 ---------- */

  function bindEvents() {
    $('tabBtnForm').addEventListener('click', function () { switchTab('form'); });
    $('tabBtnRecords').addEventListener('click', function () { switchTab('records'); });

    $('customerSelect').addEventListener('change', function () {
      toggleNewCustomerBox();
      updateModifiedHighlights();
    });

    $('deliveryChips').querySelectorAll('.chip').forEach(function (ch) {
      ch.addEventListener('click', function () {
        var pv = ch.getAttribute('data-preset');
        setDeliveryUI(pv ? { type: 'preset', value: pv } : { type: 'none', value: '' }, true);
      });
    });

    $('deliveryDate').addEventListener('change', function () {
      var v = $('deliveryDate').value;
      setDeliveryUI(v ? { type: 'date', value: v } : { type: 'none', value: '' }, true);
    });

    ['note1', 'note2', 'note3'].forEach(function (id) {
      $(id).addEventListener('input', updateModifiedHighlights);
    });

    $('btnAddItem').addEventListener('click', function () {
      state.items = collectItemsRaw();
      state.items.push({ name: '', qty: 1, price: '', specsText: '' });
      renderItems();
    });

    $('quoteForm').addEventListener('submit', onSubmitForm);
    $('btnSwitchToRevise').addEventListener('click', function () {
      state.mode = 'revise';
      updateModeUI();
    });
    $('btnNewAnother').addEventListener('click', resetToCreateMode);
    $('btnCloseLiff').addEventListener('click', function () {
      if (liff.isInClient()) liff.closeWindow();
      else window.close();
    });

    $('btnAddShortcut').addEventListener('click', async function () {
      try {
        await liff.createShortcutOnHomeScreen({ url: 'https://liff.line.me/' + CFG.LIFF_ID });
      } catch (err) {
        window.alert('無法建立桌面捷徑：' + (err && err.message || err));
      }
    });

    ['recSearch', 'recFilterCustomer', 'recFilterMonth', 'recFilterStatus'].forEach(function (id) {
      $(id).addEventListener('input', renderRecords);
      $(id).addEventListener('change', renderRecords);
    });
  }

  /** 同時讀取一般 query 參數與 LINE LIFF 傳入的 liff.state（例如 ?liff.state=%3Ftab%3Drecords） */
  function getLiffUrlParams() {
    var direct = new URLSearchParams(window.location.search);
    var liffState = direct.get('liff.state');
    if (liffState) {
      var qIdx = liffState.indexOf('?');
      var qs = qIdx >= 0 ? liffState.slice(qIdx + 1) : liffState.replace(/^\/+/, '');
      var nested = new URLSearchParams(qs);
      nested.forEach(function (v, k) {
        if (!direct.has(k)) direct.set(k, v);
      });
    }
    return direct;
  }

  async function boot() {
    bindEvents();
    if (!CFG.LIFF_ID || CFG.LIFF_ID.indexOf('請填入') >= 0 || !CFG.GAS_API_URL || CFG.GAS_API_URL.indexOf('請填入') >= 0) {
      hideLoading();
      showError('尚未設定 liff/config.js 的 LIFF_ID 與 GAS_API_URL。');
      return;
    }

    try {
      await liff.init({ liffId: CFG.LIFF_ID });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return;
      }

      var ctx = liff.getContext && liff.getContext();
      if (ctx && ctx.type === 'group' && ctx.groupId) state.contextGroupId = ctx.groupId;

      if (liff.isApiAvailable && liff.isApiAvailable('createShortcutOnHomeScreen') && typeof liff.createShortcutOnHomeScreen === 'function') {
        $('btnAddShortcut').classList.remove('hidden');
      }

      var params = getLiffUrlParams();
      var urlMode = params.get('mode');
      var urlNo = params.get('no') || '';
      var urlTab = params.get('tab') || '';
      if ((urlMode === 'edit' || urlMode === 'revise') && urlNo) {
        state.mode = urlMode;
        state.no = urlNo.toUpperCase();
      }

      var res = await callGas('init', { mode: state.mode, no: state.no });
      hideLoading();
      if (!res || !res.ok) {
        showError((res && res.error) || '驗證失敗，您可能沒有使用權限。');
        return;
      }

      $('userBadge').textContent = (res.user && res.user.displayName) || '已驗證';
      state.customers = res.customers || [];
      state.itemSuggestions = res.itemSuggestions || [];
      if (res.defaultNotes && res.defaultNotes.length) state.defaultNotes = res.defaultNotes;

      renderCustomerOptions();
      renderItemSuggestions();
      resetToCreateMode();

      if (res.quote) {
        state.mode = urlMode;
        state.no = res.quote.quoteNo;
        applyQuoteDetail(res.quote);
      }

      restoreFormFromSession();
      $('mainApp').classList.remove('hidden');

      if (urlTab === 'records') switchTab('records');
    } catch (err) {
      hideLoading();
      if (err && err.message === 'TOKEN_REFRESHING') return;
      showError('初始化失敗：' + (err && err.message || err));
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
