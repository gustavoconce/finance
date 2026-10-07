"use strict";

/* =====================================================
   CONFIG — altere aqui
===================================================== */
const CONFIG = {
    API_URL: "https://script.google.com/macros/s/AKfycbw9PrVaCyGu-M7CisYxeoLDLCLuuEBsW2wAYFrJHbYPWyoqqtLmlrZUml7GBSD4SYMZ/exec",
    APP_PASSWORD: "1001",
    DEFAULT_THEME: "dark",
    THEME_KEY: "theme",
    AUTH_KEY: "finance_auth",
    TOAST_DURATION: 4000
};

/* =====================================================
   CONSTANTES
===================================================== */
const TRANSACTION_TYPES = [
    { id: "alimentacao", name: "Alimentação", movement: "debito" },
    { id: "transporte", name: "Transporte", movement: "debito" },
    { id: "entretenimento", name: "Entretenimento", movement: "debito" },
    { id: "outros_debito", name: "Outros", movement: "debito" },
    { id: "salario", name: "Salário", movement: "acrescimo" },
    { id: "hora_extra", name: "Hora extra", movement: "acrescimo" },
    { id: "bonus", name: "Bônus", movement: "acrescimo" },
    { id: "outros_acrescimo", name: "Outros", movement: "acrescimo" }
];

const MOVEMENTS = {
    acrescimo: { group: "Entradas", hint: "Esta transação adicionará dinheiro ao seu saldo.", sign: "+", css: "is-positive", icon: "arrow-down-left" },
    debito: { group: "Saídas", hint: "Esta transação será descontada do seu saldo.", sign: "-", css: "is-negative", icon: "arrow-up-right" }
};

const WEDDING_EXPENSES = [
    { id: "ceremony-space", name: "Espaço da cerimônia" },
    { id: "apartment-entry", name: "Entrada apartamento" },
    { id: "buffet", name: "Buffet" },
    { id: "photography", name: "Fotografia" }
];

const VIEWS = {
    dashboard: { title: "Dashboard", description: "Visão geral das suas finanças no mês" },
    transactions: { title: "Transações", description: "Histórico de entradas e saídas por mês" },
    wedding: { title: "Casamento", description: "Controle das despesas e parcelas do casamento" }
};

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const MONTHS_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

const MESSAGES = {
    connection: "Não foi possível conectar ao servidor. Tente novamente.",
    emptyMonth: "Você ainda não possui transações neste mês.",
    noGoal: "Defina uma meta para este mês.",
    weddingNotConfigured: "Esta despesa ainda não foi configurada.",
    wrongPassword: "Senha incorreta."
};

/* =====================================================
   ESTADO DA APLICAÇÃO
===================================================== */
const state = {
    currentView: "dashboard",
    theme: CONFIG.DEFAULT_THEME,
    transactions: [],
    goal: null,
    dashboard: { loading: false, loaded: false, error: null },
    transactionsView: { range: null, items: [], loading: false, error: null },
    wedding: { configs: [], installments: [], loading: false, loaded: false, error: null },
    currentWeddingExpense: null,
    pendingDeleteId: null,
    pendingRequests: 0
};

/* =====================================================
   HELPERS
===================================================== */
const $ = (selector, root = document) => root.querySelector(selector);
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percentFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

function formatCurrency(value) {
    return currencyFormatter.format(Number(value) || 0);
}

function formatPercent(value) {
    return `${percentFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function pad(n) {
    return String(n).padStart(2, "0");
}

function toCents(value) {
    return Math.round(Number(value) * 100);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function toISODate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayISO() {
    return toISODate(new Date());
}

/** "2026-10-05" -> "05/10/2026" (sem criar Date, evitando timezone) */
function formatDate(iso) {
    const [y, m, d] = String(iso || "").split("-");
    return y && m && d ? `${d}/${m}/${y}` : "—";
}

/** "11/2026" -> "Nov/2026" */
function formatMonth(monthYear) {
    const [m, y] = String(monthYear || "").split("/");
    return MONTHS_SHORT[Number(m) - 1] ? `${MONTHS_SHORT[Number(m) - 1]}/${y}` : monthYear;
}

/** Intervalo [start, end) de um mês: start = dia 1, end = dia 1 do mês seguinte */
function getMonthRange(year, month) {
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return {
        year,
        month,
        key: `${year}-${pad(month)}`,
        start: `${year}-${pad(month)}-01`,
        end: `${nextYear}-${pad(nextMonth)}-01`,
        label: `${MONTHS[month - 1]} de ${year}`
    };
}

function getCurrentMonthRange() {
    const now = new Date();
    return getMonthRange(now.getFullYear(), now.getMonth() + 1);
}

/** Aceita "1.250,50", "1250.5", "R$ 1.250", "1250" */
function parseAmount(input) {
    let text = String(input || "").replace(/[R$\s]/g, "");
    if (!text) return NaN;
    if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
    const value = Number(text);
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : NaN;
}

function formatAmountInput(value) {
    return value ? Number(value).toFixed(2).replace(".", ",") : "";
}

/** Divide um total em parcelas sem erro de ponto flutuante (diferença na última) */
function splitInstallments(total, count) {
    const cents = toCents(total);
    const base = Math.floor(cents / count);
    const rest = cents - base * count;
    return Array.from({ length: count }, (_, i) => (i === count - 1 ? base + rest : base) / 100);
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function storageGet(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
}

function storageSet(storage, key, value) {
    try { value === null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* armazenamento indisponível */ }
}

function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
}

function getTransactionType(id) {
    return TRANSACTION_TYPES.find((type) => type.id === id) || null;
}

function getMovement(transaction) {
    const type = getTransactionType(transaction.tipo);
    return type ? type.movement : transaction.movimento;
}

function calculateTotals(transactions) {
    let income = 0;
    let expense = 0;
    transactions.forEach((tx) => {
        if (getMovement(tx) === "acrescimo") income += toCents(tx.valor);
        else expense += toCents(tx.valor);
    });
    return { income: income / 100, expense: expense / 100, balance: (income - expense) / 100 };
}

function sortTransactions(list) {
    return [...list].sort((a, b) => (b.data.localeCompare(a.data)) || (Number(b.id) - Number(a.id)));
}

function getWeddingExpense(id) {
    return WEDDING_EXPENSES.find((expense) => expense.id === id) || null;
}

function getWeddingSummary(expenseId) {
    const config = state.wedding.configs.find((c) => c.setor === expenseId) || null;
    const installments = state.wedding.installments
        .filter((i) => i.setor === expenseId)
        .sort((a, b) => a.parcela - b.parcela);
    const totalCents = installments.reduce((sum, i) => sum + toCents(i.valor), 0);
    const paidCents = installments.filter((i) => i.pago).reduce((sum, i) => sum + toCents(i.valor), 0);
    const percent = totalCents ? (paidCents / totalCents) * 100 : 0;
    const status = !totalCents ? { label: "Não configurado", css: "" }
        : paidCents === totalCents ? { label: "Quitado", css: "complete" }
        : paidCents > 0 ? { label: "Em andamento", css: "progress" }
        : { label: "Pendente", css: "pending" };
    return {
        config,
        installments,
        total: totalCents / 100,
        paid: paidCents / 100,
        remaining: (totalCents - paidCents) / 100,
        percent,
        paidCount: installments.filter((i) => i.pago).length,
        status
    };
}

/* =====================================================
   API
===================================================== */
async function request(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    } catch {
        throw new Error(MESSAGES.connection);
    }
    if (!response.ok) throw new Error(`Erro no servidor (${response.status}). Tente novamente.`);
    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error("Resposta inválida do servidor.");
    }
    if (!body || body.success !== true) throw new Error((body && body.error) || "Erro desconhecido no servidor.");
    if (!("data" in body)) throw new Error("A API respondeu sem dados. Verifique se o Apps Script publicado está atualizado.");
    return body.data;
}

async function withLoading(task) {
    setGlobalLoading(1);
    try {
        return await task();
    } finally {
        setGlobalLoading(-1);
    }
}

function apiGet(action, params = {}) {
    const url = new URL(CONFIG.API_URL);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    return withLoading(() => request(url.toString(), { method: "GET" }));
}

function apiPost(action, payload = {}) {
    // text/plain evita preflight CORS no Google Apps Script
    return withLoading(() => request(CONFIG.API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...payload })
    }));
}

/* =====================================================
   TRANSAÇÕES
===================================================== */
async function getDashboardData() {
    const range = getCurrentMonthRange();
    state.dashboard.loading = true;
    state.dashboard.error = null;
    renderDashboard();
    try {
        const data = await apiGet("getDashboard", { start: range.start, end: range.end, ano: range.year, mes: range.month });
        state.transactions = data.transactions || [];
        state.goal = data.goal || null;
        state.dashboard.loaded = true;
    } catch (error) {
        state.dashboard.error = error.message;
        showToast(error.message, "error");
    } finally {
        state.dashboard.loading = false;
    }
    renderDashboard();
    if (state.currentView === "transactions") loadTransactionsView();
}

function getTransactions(range) {
    return apiGet("getTransactions", { start: range.start, end: range.end });
}

function saveTransaction(transaction) {
    return apiPost("addTransaction", transaction);
}

function getSelectedTransactionsRange() {
    const input = $("#transactions-month");
    if (!input.value) input.value = getCurrentMonthRange().key;
    const [year, month] = input.value.split("-").map(Number);
    return getMonthRange(year, month);
}

async function loadTransactionsView() {
    const view = state.transactionsView;
    const range = getSelectedTransactionsRange();
    view.range = range;
    view.error = null;

    // Mês atual já carregado pelo dashboard: reaproveita o state
    if (range.key === getCurrentMonthRange().key && state.dashboard.loaded) {
        view.items = state.transactions;
        view.loading = false;
        renderTransactions();
        return;
    }

    view.loading = true;
    renderTransactions();
    try {
        const items = await getTransactions(range);
        if (view.range === range) view.items = items;
    } catch (error) {
        if (view.range === range) {
            view.items = [];
            view.error = error.message;
        }
        showToast(error.message, "error");
    } finally {
        if (view.range === range) {
            view.loading = false;
            renderTransactions();
        }
    }
}

function readTransactionForm(form) {
    const type = getTransactionType($("#tx-type", form).value);
    const valor = parseAmount($("#tx-value", form).value);
    const data = $("#tx-date", form).value;
    const descricao = $("#tx-description", form).value.trim() || (type ? type.name : "");

    if (!type) throw new Error("Selecione o tipo da transação.");
    if (!(valor > 0)) throw new Error("Informe um valor válido maior que zero.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error("Informe uma data válida.");

    return { tipo: type.id, movimento: type.movement, valor, descricao, data };
}

async function handleTransactionSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await submitForm(form, async () => {
        const transaction = readTransactionForm(form);
        await saveTransaction(transaction);
        closeModal("transaction-modal");
        showToast("Transação salva com sucesso.", "success");
        await getDashboardData();
    });
}

function deleteTransaction(id) {
    return apiPost("deleteTransaction", { id });
}

function openDeleteTransactionModal(id) {
    const tx = [...state.transactions, ...state.transactionsView.items].find((t) => t.id === id);
    if (!tx) return;
    state.pendingDeleteId = id;
    $("#confirm-message").textContent = `Excluir "${tx.descricao}" (${formatDate(tx.data)}, ${formatCurrency(tx.valor)})? Esta ação não pode ser desfeita.`;
    openModal("confirm-modal");
}

async function handleDeleteSubmit(event) {
    event.preventDefault();
    await submitForm(event.currentTarget, async () => {
        await deleteTransaction(state.pendingDeleteId);
        closeModal("confirm-modal");
        showToast("Transação excluída.", "success");
        await getDashboardData();
    });
}

/* =====================================================
   METAS
===================================================== */
function saveGoal(goal) {
    return apiPost("saveGoal", goal);
}

async function handleGoalSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await submitForm(form, async () => {
        const valor = parseAmount($("#goal-value", form).value);
        if (!(valor > 0)) throw new Error("Informe um valor de meta maior que zero.");
        const range = getCurrentMonthRange();
        state.goal = await saveGoal({ ano: range.year, mes: range.month, tipo: "economia", valor });
        closeModal("goal-modal");
        renderDashboard();
        showToast("Meta salva com sucesso.", "success");
    });
}

/* =====================================================
   CASAMENTO
===================================================== */
async function getWeddingData() {
    const wedding = state.wedding;
    wedding.loading = true;
    wedding.error = null;
    renderWedding();
    try {
        const data = await apiGet("getWedding");
        wedding.configs = data.configs || [];
        wedding.installments = data.installments || [];
        wedding.loaded = true;
    } catch (error) {
        wedding.error = error.message;
        showToast(error.message, "error");
    } finally {
        wedding.loading = false;
    }
    renderWedding();
}

function configureWeddingExpense(config) {
    return apiPost("configureWeddingExpense", config);
}

function updateWeddingPayment(id, pago) {
    return apiPost("updateWeddingPayment", { id, pago });
}

function openWeddingExpense(expenseId) {
    if (!getWeddingExpense(expenseId)) return;
    state.currentWeddingExpense = expenseId;
    renderWedding();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeWeddingExpense() {
    state.currentWeddingExpense = null;
    renderWedding();
}

function readWeddingForm(form) {
    const valor_total = parseAmount($("#wedding-total", form).value);
    const parcelas = Number($("#wedding-installments", form).value);
    const primeiro_pagamento = $("#wedding-first-date", form).value;
    if (!(valor_total > 0)) throw new Error("Informe um valor total maior que zero.");
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 360) throw new Error("Informe um número de parcelas entre 1 e 360.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(primeiro_pagamento)) throw new Error("Informe a data do primeiro pagamento.");
    return { setor: $("#wedding-sector", form).value, valor_total, parcelas, primeiro_pagamento };
}

async function handleWeddingSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await submitForm(form, async () => {
        await configureWeddingExpense(readWeddingForm(form));
        closeModal("wedding-modal");
        showToast("Despesa configurada e parcelas geradas.", "success");
        await getWeddingData();
    });
}

async function handlePaymentToggle(input) {
    const id = Number(input.dataset.installmentId);
    const pago = input.checked;
    input.disabled = true;
    try {
        const updated = await updateWeddingPayment(id, pago);
        const installment = state.wedding.installments.find((i) => i.id === id);
        if (installment) installment.pago = updated.pago;
        renderWedding();
        showToast(pago ? "Parcela marcada como paga." : "Parcela marcada como pendente.", "success");
    } catch (error) {
        input.checked = !pago;
        input.disabled = false;
        showToast(error.message, "error");
    }
}

function updateWeddingPreview() {
    const total = parseAmount($("#wedding-total").value);
    const count = Number($("#wedding-installments").value);
    const preview = $("#wedding-preview");
    if (!(total > 0) || !Number.isInteger(count) || count < 1 || count > 360) {
        preview.hidden = true;
        return;
    }
    const parts = splitInstallments(total, count);
    const first = parts[0];
    const last = parts[parts.length - 1];
    preview.textContent = first === last
        ? `${count}x de ${formatCurrency(first)}`
        : `${count - 1}x de ${formatCurrency(first)} + última de ${formatCurrency(last)}`;
    preview.hidden = false;
}

/* =====================================================
   RENDERIZAÇÃO
===================================================== */
function stateMessage(text, variant = "", extra = "") {
    const spinner = variant === "loading" ? '<span class="spinner" aria-hidden="true"></span>' : "";
    return `<div class="state-msg ${variant}" role="${variant === "error" ? "alert" : "status"}">${spinner}<p>${escapeHtml(text)}</p>${extra}</div>`;
}

function renderProgress(percent, css = "") {
    const width = clamp(percent, 0, 100);
    return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(width)}"><div class="progress-bar ${css}" style="width:${width}%"></div></div>`;
}

function renderTransactionItem(tx) {
    const type = getTransactionType(tx.tipo);
    const movement = MOVEMENTS[getMovement(tx)] || MOVEMENTS.debito;
    return `
        <li class="tx-item">
            <span class="tx-icon ${movement.css}" aria-hidden="true"><i data-lucide="${movement.icon}"></i></span>
            <div class="tx-info">
                <strong>${escapeHtml(tx.descricao)}</strong>
                <span>${escapeHtml(type ? type.name : tx.tipo)} · ${formatDate(tx.data)}</span>
            </div>
            <span class="tx-amount ${movement.css}">${movement.sign} ${formatCurrency(tx.valor)}</span>
            <button type="button" class="icon-btn tx-delete" data-action="delete-transaction" data-id="${tx.id}" aria-label="Excluir ${escapeHtml(tx.descricao)}"><i data-lucide="trash-2"></i></button>
        </li>`;
}

function renderTransactionList(container, { items, loading, error }) {
    if (loading) container.innerHTML = stateMessage("Carregando transações...", "loading");
    else if (error) container.innerHTML = stateMessage(error, "error");
    else if (!items.length) container.innerHTML = stateMessage(MESSAGES.emptyMonth);
    else container.innerHTML = `<ul class="tx-list">${sortTransactions(items).map(renderTransactionItem).join("")}</ul>`;
    refreshIcons();
}

function renderDashboard() {
    const { loading, loaded, error } = state.dashboard;
    const range = getCurrentMonthRange();
    const totals = calculateTotals(state.transactions);
    const showValues = loaded;

    $("#dashboard-month").textContent = range.label;
    const balanceEl = $("#stat-balance");
    balanceEl.textContent = showValues ? formatCurrency(totals.balance) : "—";
    balanceEl.classList.toggle("is-negative", showValues && totals.balance < 0);
    $("#stat-income").textContent = showValues ? `+ ${formatCurrency(totals.income)}` : "—";
    $("#stat-expense").textContent = showValues ? `- ${formatCurrency(totals.expense)}` : "—";

    const count = (movement) => state.transactions.filter((tx) => getMovement(tx) === movement).length;
    $("#stat-income-sub").textContent = showValues ? `${count("acrescimo")} entrada(s)` : "";
    $("#stat-expense-sub").textContent = showValues ? `${count("debito")} saída(s)` : "";

    renderGoal(totals);
    renderTransactionList($("#dashboard-transactions"), {
        items: state.transactions,
        loading: loading && !loaded,
        error: loaded ? null : error
    });
}

function renderGoal(totals) {
    const container = $("#goal-content");
    const goalStat = $("#stat-goal");
    const goalSub = $("#stat-goal-sub");
    const { loading, loaded, error } = state.dashboard;

    if (!loaded) {
        goalStat.textContent = "—";
        goalSub.textContent = "";
        container.innerHTML = loading ? stateMessage("Carregando meta...", "loading") : stateMessage(error || "", "error");
        return;
    }

    if (!state.goal || !(Number(state.goal.valor) > 0)) {
        goalStat.textContent = "—";
        goalSub.textContent = "Nenhuma meta definida";
        container.innerHTML = stateMessage(MESSAGES.noGoal, "", '<button type="button" class="btn btn-primary btn-sm" data-action="edit-goal">Definir meta</button>');
        return;
    }

    const goal = Number(state.goal.valor);
    const balance = totals.balance;
    const percent = (balance / goal) * 100;
    const status = balance < 0 ? "negative" : percent >= 100 ? "complete" : "";
    const message = balance < 0
        ? "Saldo negativo neste mês. Os débitos superaram os acréscimos."
        : percent >= 100 ? "Meta atingida! Parabéns." : `Faltam ${formatCurrency(goal - balance)} para atingir a meta.`;

    goalStat.textContent = formatCurrency(goal);
    goalSub.textContent = `${formatPercent(Math.max(percent, 0))} atingido`;
    container.innerHTML = `
        <div class="goal-top">
            <span class="goal-pct ${status}">${formatPercent(Math.max(percent, 0))}</span>
            <span class="muted">${formatCurrency(balance)} / ${formatCurrency(goal)}</span>
        </div>
        ${renderProgress(percent, status)}
        <dl class="meta-list">
            <div><dt>Meta</dt><dd>${formatCurrency(goal)}</dd></div>
            <div><dt>Acumulado</dt><dd class="${balance < 0 ? "is-negative" : ""}">${formatCurrency(balance)}</dd></div>
            <div><dt>Restante</dt><dd>${formatCurrency(Math.max(goal - balance, 0))}</dd></div>
        </dl>
        <p class="goal-status ${balance < 0 ? "is-negative" : percent >= 100 ? "is-positive" : "muted"}">${message}</p>`;
}

function renderTransactions() {
    const view = state.transactionsView;
    const summary = $("#transactions-summary");
    if (view.loading || view.error) {
        summary.hidden = true;
    } else {
        const totals = calculateTotals(view.items);
        summary.hidden = false;
        summary.innerHTML = `
            <div><span>Acréscimos</span><strong class="is-positive">+ ${formatCurrency(totals.income)}</strong></div>
            <div><span>Débitos</span><strong class="is-negative">- ${formatCurrency(totals.expense)}</strong></div>
            <div><span>Saldo líquido</span><strong class="${totals.balance < 0 ? "is-negative" : ""}">${formatCurrency(totals.balance)}</strong></div>`;
    }
    renderTransactionList($("#transactions-list"), view);
}

function renderWeddingExpense(expense) {
    const summary = getWeddingSummary(expense.id);
    const name = escapeHtml(expense.name);
    const body = summary.config
        ? `<div class="wc-amount">${formatCurrency(summary.total)}</div>
           <div class="wc-meta"><span>${formatCurrency(summary.paid)} pago</span><span>${formatPercent(summary.percent)}</span></div>
           ${renderProgress(summary.percent, summary.status.css === "complete" ? "complete" : "")}
           <div class="wc-foot"><span class="badge ${summary.status.css}">${summary.status.label}</span><span>${summary.paidCount}/${summary.installments.length} parcelas</span></div>`
        : `<p class="muted">Não configurado</p><div><span class="badge">Configurar</span></div>`;
    return `
        <article class="card wedding-card" data-action="open-wedding" data-id="${expense.id}">
            <div class="wc-head">
                <h3><button type="button" class="wc-title" data-action="open-wedding" data-id="${expense.id}">${name}</button></h3>
                <button type="button" class="icon-btn" data-action="config-wedding" data-id="${expense.id}" aria-label="Configurar ${name}"><i data-lucide="settings"></i></button>
            </div>
            ${body}
        </article>`;
}

function renderWeddingDetail(expense) {
    const summary = getWeddingSummary(expense.id);
    const head = `
        <div class="detail-head">
            <button type="button" class="icon-btn" data-action="back-wedding" aria-label="Voltar para despesas"><i data-lucide="arrow-left"></i></button>
            <h2>${escapeHtml(expense.name)}</h2>
            <button type="button" class="btn btn-ghost btn-sm" data-action="config-wedding" data-id="${expense.id}"><i data-lucide="settings"></i>Configurar</button>
        </div>`;

    if (!summary.config) {
        return head + `<article class="card">${stateMessage(MESSAGES.weddingNotConfigured, "", `<button type="button" class="btn btn-primary btn-sm" data-action="config-wedding" data-id="${expense.id}">Configurar despesa</button>`)}</article>`;
    }

    const rows = summary.installments.map((i) => `
        <tr class="${i.pago ? "paid" : ""}">
            <td>${i.parcela}</td>
            <td>${formatMonth(i.mes)}</td>
            <td>${formatCurrency(i.valor)}</td>
            <td class="center"><input type="checkbox" class="check" data-installment-id="${i.id}" ${i.pago ? "checked" : ""} aria-label="Parcela ${i.parcela} paga"></td>
        </tr>`).join("");

    return head + `
        <div class="detail-stats">
            <article class="card stat"><span class="stat-label">Total</span><strong class="stat-value">${formatCurrency(summary.total)}</strong></article>
            <article class="card stat"><span class="stat-label">Pago</span><strong class="stat-value is-positive">${formatCurrency(summary.paid)}</strong></article>
            <article class="card stat"><span class="stat-label">Restante</span><strong class="stat-value">${formatCurrency(summary.remaining)}</strong></article>
            <article class="card stat"><span class="stat-label">Progresso</span><strong class="stat-value">${formatPercent(summary.percent)}</strong><span class="badge ${summary.status.css}" style="align-self:flex-start">${summary.status.label}</span></article>
        </div>
        <article class="card">
            ${renderProgress(summary.percent, summary.status.css === "complete" ? "complete" : "")}
            <p class="detail-info muted">${summary.config.parcelas} parcela(s) · primeiro pagamento em ${formatDate(summary.config.primeiro_pagamento)} · ${summary.paidCount} paga(s)</p>
        </article>
        <article class="card" style="margin-top:16px">
            <div class="table-wrap">
                <table class="table">
                    <thead><tr><th scope="col">Parcela</th><th scope="col">Mês</th><th scope="col">Valor</th><th scope="col" class="center">Pago</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </article>`;
}

function renderWedding() {
    const container = $("#wedding-content");
    const { loading, loaded, error } = state.wedding;
    const expense = getWeddingExpense(state.currentWeddingExpense);

    if (!loaded) {
        container.innerHTML = loading
            ? `<article class="card">${stateMessage("Carregando despesas...", "loading")}</article>`
            : `<article class="card">${stateMessage(error || "", "error", '<button type="button" class="btn btn-ghost btn-sm" data-action="reload-wedding">Tentar novamente</button>')}</article>`;
    } else if (expense) {
        container.innerHTML = renderWeddingDetail(expense);
    } else {
        container.innerHTML = `<div class="wedding-grid">${WEDDING_EXPENSES.map(renderWeddingExpense).join("")}</div>`;
    }
    refreshIcons();
}

/* =====================================================
   MODAIS E FEEDBACK
===================================================== */
function openModal(id) {
    const dialog = document.getElementById(id);
    setFormError($("form", dialog), null);
    dialog.showModal();
}

function closeModal(id) {
    const dialog = document.getElementById(id);
    if (dialog.open) dialog.close();
}

function setFormError(form, message) {
    const el = $(".form-error", form);
    el.textContent = message || "";
    el.hidden = !message;
}

/** Executa um submit com estado de carregamento; em erro mantém o modal aberto e os dados */
async function submitForm(form, task) {
    const button = $('button[type="submit"]', form);
    const label = button.textContent;
    setFormError(form, null);
    button.disabled = true;
    button.textContent = "Aguarde...";
    try {
        await task();
    } catch (error) {
        setFormError(form, error.message);
        showToast(error.message, "error");
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}

function openTransactionModal() {
    const form = $("#transaction-form");
    form.reset();
    $("#tx-date").value = todayISO();
    updateMovementHint();
    openModal("transaction-modal");
    $("#tx-type").focus();
}

function openGoalModal() {
    $("#goal-value").value = state.goal ? formatAmountInput(state.goal.valor) : "";
    $("#goal-modal-month").textContent = `Meta para ${getCurrentMonthRange().label}`;
    openModal("goal-modal");
    $("#goal-value").focus();
}

function openWeddingConfigModal(expenseId) {
    const expense = getWeddingExpense(expenseId);
    if (!expense) return;
    const config = state.wedding.configs.find((c) => c.setor === expenseId);
    $("#wedding-modal-title").textContent = `Configurar: ${expense.name}`;
    $("#wedding-sector").value = expense.id;
    $("#wedding-total").value = config ? formatAmountInput(config.valor_total) : "";
    $("#wedding-installments").value = config ? config.parcelas : "";
    $("#wedding-first-date").value = config ? config.primeiro_pagamento : "";
    $("#wedding-warning").hidden = !config;
    updateWeddingPreview();
    openModal("wedding-modal");
    $("#wedding-total").focus();
}

function populateTransactionTypes() {
    const select = $("#tx-type");
    const groups = Object.entries(MOVEMENTS).map(([movement, info]) => {
        const options = TRANSACTION_TYPES
            .filter((type) => type.movement === movement)
            .map((type) => `<option value="${type.id}">${escapeHtml(type.name)}</option>`)
            .join("");
        return `<optgroup label="${info.group}">${options}</optgroup>`;
    });
    select.innerHTML = `<option value="">Selecione o tipo</option>${groups.join("")}`;
}

function updateMovementHint() {
    const type = getTransactionType($("#tx-type").value);
    const hint = $("#tx-movement-hint");
    if (!type) {
        hint.hidden = true;
        return;
    }
    const movement = MOVEMENTS[type.movement];
    hint.textContent = movement.hint;
    hint.className = `hint ${movement.css}`;
    hint.hidden = false;
}

function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;
    $("#toasts").appendChild(toast);
    setTimeout(() => toast.remove(), CONFIG.TOAST_DURATION);
}

function setGlobalLoading(delta) {
    state.pendingRequests = Math.max(0, state.pendingRequests + delta);
    $("#loader").hidden = state.pendingRequests === 0;
}

/* =====================================================
   NAVEGAÇÃO
===================================================== */
function navigate(view) {
    if (!VIEWS[view]) return;
    state.currentView = view;
    document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
        const active = item.dataset.view === view;
        item.classList.toggle("active", active);
        if (active) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
    });
    $("#page-title").textContent = VIEWS[view].title;
    $("#page-description").textContent = VIEWS[view].description;
    closeSidebar();

    if (view === "transactions") loadTransactionsView();
    if (view === "wedding") {
        if (!state.wedding.loaded && !state.wedding.loading) getWeddingData();
        else renderWedding();
    }
}

function openSidebar() {
    $("#sidebar").classList.add("open");
    $("#sidebar-backdrop").hidden = false;
}

function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#sidebar-backdrop").hidden = true;
}

/* =====================================================
   TEMA
===================================================== */
function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    storageSet(localStorage, CONFIG.THEME_KEY, state.theme);
}

function toggleTheme() {
    setTheme(state.theme === "dark" ? "light" : "dark");
}

/* =====================================================
   LOGIN
===================================================== */
function checkLogin() {
    return storageGet(sessionStorage, CONFIG.AUTH_KEY) === "1";
}

function login(password) {
    if (password !== CONFIG.APP_PASSWORD) return false;
    storageSet(sessionStorage, CONFIG.AUTH_KEY, "1");
    return true;
}

function logout() {
    storageSet(sessionStorage, CONFIG.AUTH_KEY, null);
    showLogin();
}

function showLogin() {
    $("#app").hidden = true;
    $("#login-screen").hidden = false;
    $("#login-form").reset();
    $("#login-password").focus();
}

function showApp() {
    $("#login-screen").hidden = true;
    $("#app").hidden = false;
    navigate("dashboard");
    if (!state.dashboard.loaded) getDashboardData();
}

function handleLoginSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (login($("#login-password").value)) {
        setFormError(form, null);
        showApp();
    } else {
        setFormError(form, MESSAGES.wrongPassword);
        $("#login-password").select();
    }
}

/* =====================================================
   EVENT LISTENERS
===================================================== */
const ACTIONS = {
    "new-transaction": () => openTransactionModal(),
    "edit-goal": () => openGoalModal(),
    "delete-transaction": (el) => openDeleteTransactionModal(Number(el.dataset.id)),
    "open-wedding": (el) => openWeddingExpense(el.dataset.id),
    "config-wedding": (el) => openWeddingConfigModal(el.dataset.id),
    "back-wedding": () => closeWeddingExpense(),
    "reload-wedding": () => getWeddingData()
};

function bindEvents() {
    $("#login-form").addEventListener("submit", handleLoginSubmit);
    $("#transaction-form").addEventListener("submit", handleTransactionSubmit);
    $("#goal-form").addEventListener("submit", handleGoalSubmit);
    $("#wedding-form").addEventListener("submit", handleWeddingSubmit);
    $("#confirm-form").addEventListener("submit", handleDeleteSubmit);

    $("#tx-type").addEventListener("change", updateMovementHint);
    $("#wedding-total").addEventListener("input", updateWeddingPreview);
    $("#wedding-installments").addEventListener("input", updateWeddingPreview);
    $("#transactions-month").addEventListener("change", loadTransactionsView);

    $("#theme-toggle").addEventListener("click", toggleTheme);
    $("#logout-btn").addEventListener("click", logout);
    $("#menu-btn").addEventListener("click", openSidebar);
    $("#sidebar-backdrop").addEventListener("click", closeSidebar);

    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
        item.addEventListener("click", () => navigate(item.dataset.view));
    });

    document.addEventListener("click", (event) => {
        const closer = event.target.closest("[data-close]");
        if (closer) {
            closer.closest("dialog").close();
            return;
        }
        const target = event.target.closest("[data-action]");
        if (target && ACTIONS[target.dataset.action]) ACTIONS[target.dataset.action](target);
    });

    document.addEventListener("change", (event) => {
        if (event.target.matches("input[data-installment-id]")) handlePaymentToggle(event.target);
    });

    // Fecha modal ao clicar fora (no backdrop)
    document.querySelectorAll("dialog.modal").forEach((dialog) => {
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog.close();
        });
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeSidebar();
    });
}

/* =====================================================
   INITIALIZATION
===================================================== */
function init() {
    setTheme(storageGet(localStorage, CONFIG.THEME_KEY) || CONFIG.DEFAULT_THEME);
    populateTransactionTypes();
    bindEvents();
    refreshIcons();
    if (checkLogin()) showApp();
    else showLogin();
}

document.addEventListener("DOMContentLoaded", init);
