import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as db from './db';
import type { BackupPreview } from './db';
import Community, { AccountSettings, AuthPage, DeleteAccountPage, FollowingPage, LogoutAccountPage, MyPostsPage, PasswordChangePage, ProfileEditPage, type Profile as CommunityProfile } from './community';
import { supabase } from './supabase';
import { Icon } from './Icon';
import type { CheckRun, CheckTemplate, Checklist, ChecklistItem, LocalDatabase, Meter, MeterReading, NavKey, Pet, PetEvent, PetEventKind, StoreName, ThemeChoice } from './types';

type DataState = { [K in StoreName]: LocalDatabase[K][] };
type ProfileView = 'home' | 'auth' | 'account' | 'edit-profile' | 'change-password' | 'delete-account' | 'logout' | 'following' | 'posts';
const AdminPortal = lazy(() => import('./AdminPortal'));
const emptyData: DataState = { checklists: [], checklistItems: [], checkTemplates: [], checkRuns: [], meters: [], meterReadings: [], pets: [], petEvents: [], preferences: [] };
const id = () => crypto.randomUUID();
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const reminderLabel = (date?: string) => !date ? '未设置提醒' : date < today() ? `已逾期 · ${date}` : date === today() ? `今天提醒 · ${date}` : `提醒日期 · ${date}`;
const iconNames: Record<NavKey, string> = { home: 'home', lists: 'checklist', records: 'monitoring', community: 'forum', profile: 'person' };

export default function App() {
  const adminHost = window.location.hostname.toLowerCase() === 'admin.yeecc.cn';
  const localAdminRoute = import.meta.env.DEV && (window.location.pathname === '/admin' || window.location.hash === '#/admin');
  if (adminHost || localAdminRoute) return <Suspense fallback={<div className="loading"><Icon name="progress_activity" className="spin" /><p>正在打开管理工作台…</p></div>}><AdminPortal /></Suspense>;
  if (window.location.hash === '#/admin') return <RedirectToAdmin />;
  return <LifeApp />;
}

function RedirectToAdmin() {
  useEffect(() => { window.location.replace('https://admin.yeecc.cn/'); }, []);
  return <div className="loading"><Icon name="open_in_new" /><p>正在前往独立管理后台…</p></div>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div>
      {children}
    </section>
  </div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function LifeApp() {
  const [data, setData] = useState<DataState>(emptyData);
  const [ready, setReady] = useState(false);
  const [nav, setNav] = useState<NavKey>('home');
  const [profileView, setProfileView] = useState<ProfileView>('home');
  const [communityProfileId, setCommunityProfileId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const [modal, setModal] = useState<string | null>(null);
  const [selectedChecklist, setSelectedChecklist] = useState<string | null>(null);
  const [recordTab, setRecordTab] = useState<'utilities' | 'pets'>('utilities');
  const [toast, setToast] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [pendingBackup, setPendingBackup] = useState<{ fileName: string; payload: unknown; preview: BackupPreview } | null>(null);
  const [importError, setImportError] = useState('');

  const refresh = async () => {
    const stores: StoreName[] = ['checklists', 'checklistItems', 'checkTemplates', 'checkRuns', 'meters', 'meterReadings', 'pets', 'petEvents', 'preferences'];
    const result = await Promise.all(stores.map((store) => db.all(store)));
    const next = { ...emptyData } as DataState;
    stores.forEach((store, index) => { next[store] = result[index] as never; });
    setData(next);
  };

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
      const savedTheme = await db.getPreference<ThemeChoice>('theme', 'system');
      setTheme(savedTheme);
      const templates = await db.all('checkTemplates');
      if (templates.length === 0) {
        const defaults: CheckTemplate[] = [
          { id: id(), title: '上班出门', items: ['手机', '钥匙', '门卡', '钱包', '水杯'], createdAt: new Date().toISOString() },
          { id: id(), title: '健身出门', items: ['运动鞋', '水壶', '毛巾', '耳机'], createdAt: new Date().toISOString() },
          { id: id(), title: '短途出行', items: ['身份证', '充电器', '药品', '纸巾'], createdAt: new Date().toISOString() }
        ];
        await Promise.all(defaults.map((item) => db.put('checkTemplates', item)));
        await refresh();
      }
      setReady(true);
    })().catch(() => { setToast('本机数据暂时无法读取，请检查浏览器存储空间。'); setReady(true); });
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#1b1c22' : '#fff8ef');
    };
    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activePetReminders = useMemo(() => data.petEvents.filter((event) => event.reminderDate && !event.completed).sort((a, b) => (a.reminderDate ?? '').localeCompare(b.reminderDate ?? '')), [data.petEvents]);

  const persist = async <K extends StoreName>(store: K, value: LocalDatabase[K], message = '已保存') => {
    try { await db.put(store, value); await refresh(); setToast(message); }
    catch { setToast('保存失败，请检查设备空间后重试。'); }
  };

  const handleTheme = async () => {
    const next: ThemeChoice = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(next); await db.setPreference('theme', next);
  };

  const createChecklist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget); const title = String(form.get('title') ?? '').trim();
    if (!title) return;
    await persist('checklists', { id: id(), title, createdAt: new Date().toISOString() }, '清单已创建'); setModal(null);
  };

  const createExampleChecklist = async (kind: 'travel' | 'move') => {
    const title = kind === 'travel' ? '周末短途旅行' : '搬家准备';
    const examples = kind === 'travel' ? ['确认交通和住宿', '带好证件与钱包', '准备充电器和移动电源', '收拾洗漱用品', '出门前检查门窗'] : ['整理打包物品', '预约搬家车辆', '拍摄入住前房屋状态', '记录水电燃气读数', '确认钥匙和门卡'];
    const checklist: Checklist = { id: id(), title, createdAt: new Date().toISOString() };
    await db.put('checklists', checklist);
    await Promise.all(examples.map((title) => db.put('checklistItems', { id: id(), checklistId: checklist.id, title, done: false, createdAt: new Date().toISOString() })));
    await refresh(); setSelectedChecklist(checklist.id); setToast('示例清单已添加');
  };

  const renameChecklist = async (checklist: Checklist) => {
    const title = window.prompt('修改清单名称', checklist.title)?.trim();
    if (title) await persist('checklists', { ...checklist, title }, '清单名称已更新');
  };

  const toggleChecklistArchive = async (checklist: Checklist) => {
    if (!window.confirm(checklist.archivedAt ? '恢复这张清单？' : '归档这张清单？归档后仍可恢复。')) return;
    await persist('checklists', checklist.archivedAt ? { ...checklist, archivedAt: undefined } : { ...checklist, archivedAt: new Date().toISOString() }, checklist.archivedAt ? '清单已恢复' : '清单已归档');
  };

  const deleteChecklist = async (checklist: Checklist) => {
    if (!window.confirm(`确定永久删除“${checklist.title}”及其中事项吗？`)) return;
    await Promise.all(data.checklistItems.filter((item) => item.checklistId === checklist.id).map((item) => db.remove('checklistItems', item.id)));
    await db.remove('checklists', checklist.id);
    if (selectedChecklist === checklist.id) setSelectedChecklist(null);
    await refresh(); setToast('清单已删除');
  };

  const createChecklistItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedChecklist) return;
    const form = new FormData(event.currentTarget); const title = String(form.get('title') ?? '').trim();
    if (!title) return;
    await persist('checklistItems', { id: id(), checklistId: selectedChecklist, title, dueDate: String(form.get('dueDate') ?? '') || undefined, note: String(form.get('note') ?? '') || undefined, done: false, createdAt: new Date().toISOString() }, '事项已添加'); setModal(null);
  };

  const toggleItem = async (item: ChecklistItem) => persist('checklistItems', { ...item, done: !item.done, completedAt: item.done ? undefined : new Date().toISOString() }, item.done ? '已恢复事项' : '已完成');

  const startRun = async (template: CheckTemplate) => {
    const run: CheckRun = { id: id(), templateId: template.id, title: template.title, items: template.items.map((title) => ({ id: id(), title, done: false })), createdAt: new Date().toISOString() };
    await persist('checkRuns', run, '已开始检查');
  };

  const toggleRunItem = async (run: CheckRun, itemId: string) => {
    const updated = { ...run, items: run.items.map((item) => item.id === itemId ? { ...item, done: !item.done } : item) };
    if (updated.items.every((item) => item.done)) updated.completedAt = new Date().toISOString();
    else updated.completedAt = undefined;
    await persist('checkRuns', updated, updated.completedAt ? '检查完成，做得好！' : '进度已保存');
  };

  const createTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const title = String(form.get('title') ?? '').trim(); const raw = String(form.get('items') ?? '');
    const template: CheckTemplate = { id: id(), title, items: raw.split(/[，,\n]/).map((x) => x.trim()).filter(Boolean), createdAt: new Date().toISOString() };
    if (!title || template.items.length === 0) return;
    await persist('checkTemplates', template, '检查模板已保存'); setModal(null);
  };

  const editTemplate = async (template: CheckTemplate) => {
    const title = window.prompt('修改模板名称', template.title)?.trim();
    if (!title) return;
    const raw = window.prompt('检查项目（用逗号分隔）', template.items.join('，'));
    if (raw === null) return;
    const nextItems = raw.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
    if (!nextItems.length) { setToast('模板至少需要一个检查项目。'); return; }
    await persist('checkTemplates', { ...template, title, items: nextItems }, '模板已更新');
  };

  const copyTemplate = async (template: CheckTemplate) => {
    const title = window.prompt('副本名称', `${template.title}（副本）`)?.trim();
    if (!title) return;
    await persist('checkTemplates', { ...template, id: id(), title, createdAt: new Date().toISOString() }, '模板副本已创建');
  };

  const deleteTemplate = async (template: CheckTemplate) => {
    if (!window.confirm(`删除“${template.title}”模板？已完成和进行中的检查记录不会删除。`)) return;
    await db.remove('checkTemplates', template.id); await refresh(); setToast('模板已删除');
  };

  const createMeter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const name = String(form.get('name') ?? '').trim(); const kind = String(form.get('kind') ?? 'water') as Meter['kind'];
    if (!name) return;
    const meter: Meter = { id: id(), name, kind, unit: String(form.get('unit') ?? (kind === 'electricity' ? '度' : 'm³')), createdAt: new Date().toISOString() };
    await persist('meters', meter, '表具已添加'); setModal(null);
  };

  const createReading = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const meterId = String(form.get('meterId') ?? ''); const value = Number(form.get('value')); const date = String(form.get('date') ?? today());
    if (!meterId || !Number.isFinite(value) || value < 0) { setToast('请输入有效的非负读数。'); return; }
    const previous = data.meterReadings.filter((entry) => entry.meterId === meterId).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (previous && (date <= previous.date || value < previous.value)) { setToast('日期必须晚于上次抄表，读数不能小于上次记录。'); return; }
    const reading: MeterReading = { id: id(), meterId, value, date, note: String(form.get('note') ?? '') || undefined, createdAt: new Date().toISOString() };
    await persist('meterReadings', reading, '抄表记录已保存'); setModal(null);
  };

  const createPet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const name = String(form.get('name') ?? '').trim();
    if (!name) return;
    const pet: Pet = { id: id(), name, kind: String(form.get('kind') ?? '宠物'), birthday: String(form.get('birthday') ?? '') || undefined, note: String(form.get('note') ?? '') || undefined, createdAt: new Date().toISOString() };
    await persist('pets', pet, '宠物档案已创建'); setModal(null);
  };

  const createPetEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const title = String(form.get('title') ?? '').trim(); const petId = String(form.get('petId') ?? '');
    if (!title || !petId) return;
    const petEvent: PetEvent = { id: id(), petId, kind: String(form.get('kind') ?? 'custom') as PetEventKind, title, date: String(form.get('date') ?? today()), reminderDate: String(form.get('reminderDate') ?? '') || undefined, note: String(form.get('note') ?? '') || undefined, completed: false, createdAt: new Date().toISOString() };
    await persist('petEvents', petEvent, '宠物记录已保存'); setModal(null);
  };

  const exportBackup = async () => {
    try {
      const backup = await db.exportPersonalData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `日常有序备份-${today()}.json`; link.click(); URL.revokeObjectURL(url); setToast('备份文件已导出');
    } catch { setToast('导出失败，请检查浏览器存储空间。'); }
  };

  const inspectBackup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setPendingBackup(null); setImportError('');
    const file = new FormData(event.currentTarget).get('backup') as File | null;
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setImportError('备份文件不能超过 20 MB。'); return; }
    try {
      const payload: unknown = JSON.parse(await file.text());
      const preview = await db.previewPersonalImport(payload);
      setPendingBackup({ fileName: file.name, payload, preview });
    } catch (error) { setImportError(error instanceof Error ? error.message : '备份校验失败，现有数据未更改。'); }
  };

  const importBackup = async () => {
    if (!pendingBackup) return;
    setImportError('');
    try {
      const result = await db.importPersonalData(pendingBackup.payload);
      await refresh();
      const added = result.stores.reduce((sum, item) => sum + item.added, 0);
      const overwritten = result.stores.reduce((sum, item) => sum + item.overwritten, 0);
      setToast(`已导入 ${result.total} 条记录：新增 ${added} 条，覆盖 ${overwritten} 条。`);
      setPendingBackup(null); setModal(null);
    } catch (error) { setImportError(error instanceof Error ? error.message : '导入失败，原有数据未更改。'); }
  };

  const clearData = async () => {
    if (!window.confirm('确定清除本机所有清单、抄表和宠物记录吗？此操作无法撤销，建议先导出备份。')) return;
    await db.clearPersonalData(); await refresh(); setToast('本机个人记录已清除');
  };

  const markPetEvent = async (event: PetEvent) => persist('petEvents', { ...event, completed: !event.completed }, event.completed ? '提醒已恢复' : '已完成提醒');

  const navItems: { key: NavKey; label: string }[] = [
    { key: 'home', label: '首页' }, { key: 'lists', label: '清单' }, { key: 'records', label: '记录' }, { key: 'community', label: '社区' }, { key: 'profile', label: '我的' }
  ];

  if (!ready) return <div className="loading"><Icon name="progress_activity" className="spin" /><p>正在准备你的生活空间…</p></div>;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#home" onClick={(event) => { event.preventDefault(); setNav('home'); }}><span className="brandmark"><Icon name="auto_awesome" size={18} /></span><span>日常有序</span></a>
      <div className="top-actions"><span className="date-chip">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span><button className="icon-button theme-button" onClick={() => void handleTheme()} aria-label="切换日间或夜间主题"><Icon name={document.documentElement.dataset.theme === 'dark' ? 'light_mode' : 'dark_mode'} /></button></div>
    </header>
    <main className="main-content">
      {nav === 'home' && <HomePage lists={data.checklists} items={data.checklistItems} runs={data.checkRuns} templates={data.checkTemplates} meters={data.meters} readings={data.meterReadings} pets={data.pets} events={activePetReminders} onGo={setNav} onStartRun={startRun} onToggleRun={toggleRunItem} onAddReading={() => setModal('reading')} />}
      {nav === 'lists' && <ListsPage lists={data.checklists} listItems={data.checklistItems} templates={data.checkTemplates} runs={data.checkRuns} selected={selectedChecklist} setSelected={setSelectedChecklist} onNewList={() => setModal('checklist')} onNewItem={(listId) => { setSelectedChecklist(listId); setModal('item'); }} onToggleItem={toggleItem} onNewTemplate={() => setModal('template')} onStartRun={startRun} onToggleRun={toggleRunItem} onExample={createExampleChecklist} onRename={renameChecklist} onArchive={toggleChecklistArchive} onDelete={deleteChecklist} onEditTemplate={editTemplate} onCopyTemplate={copyTemplate} onDeleteTemplate={deleteTemplate} />}
      {nav === 'records' && <RecordsPage tab={recordTab} setTab={setRecordTab} meters={data.meters} readings={data.meterReadings} pets={data.pets} events={data.petEvents} onAddMeter={() => setModal('meter')} onAddReading={() => setModal('reading')} onAddPet={() => setModal('pet')} onAddPetEvent={() => setModal('pet-event')} onToggleEvent={markPetEvent} />}
      {nav === 'community' && <Community session={session} onOpenMy={() => { setProfileView('home'); setNav('profile'); }} initialProfileId={communityProfileId} onExitUserProfile={() => { setCommunityProfileId(null); setNav('profile'); }} />}
      {nav === 'profile' && <ProfilePage session={session} view={profileView} setView={setProfileView} onMessage={setToast} onTheme={handleTheme} onExport={exportBackup} onImport={() => setModal('import')} onClear={clearData} onOpenCommunityProfile={(userId) => { setCommunityProfileId(userId); setNav('community'); }} />}
    </main>
    <nav className="bottom-nav" aria-label="主导航">
      {navItems.map((item) => <button key={item.key} className={`nav-button ${nav === item.key ? 'active' : ''}`} onClick={() => setNav(item.key)} aria-current={nav === item.key ? 'page' : undefined}>
        <span className="nav-icon-wrap"><Icon name={iconNames[item.key]} size={22} /></span><span>{item.label}</span>
      </button>)}
    </nav>
    {toast && <div className="toast" role="status"><Icon name="check_circle" size={18} />{toast}</div>}
    {modal === 'checklist' && <Modal title="新建生活清单" onClose={() => setModal(null)}><form onSubmit={createChecklist} className="form-stack"><Field label="清单名称"><input autoFocus name="title" placeholder="例如：周末短途旅行" required maxLength={60} /></Field><button className="primary-button">创建清单</button></form></Modal>}
    {modal === 'item' && <Modal title="添加待办事项" onClose={() => setModal(null)}><form onSubmit={createChecklistItem} className="form-stack"><Field label="事项名称"><input autoFocus name="title" placeholder="要完成的一件事" required maxLength={100} /></Field><Field label="截止日期（可选）"><input name="dueDate" type="date" /></Field><Field label="备注（可选）"><textarea name="note" rows={3} placeholder="补充一点细节" maxLength={500} /></Field><button className="primary-button">添加事项</button></form></Modal>}
    {modal === 'template' && <Modal title="新建出门检查模板" onClose={() => setModal(null)}><form onSubmit={createTemplate} className="form-stack"><Field label="模板名称"><input autoFocus name="title" placeholder="例如：遛狗出门" required maxLength={60} /></Field><Field label="检查项目（每行或逗号分隔）"><textarea name="items" rows={5} placeholder={'牵引绳\n拾便袋\n水壶'} required /></Field><button className="primary-button">保存模板</button></form></Modal>}
    {modal === 'meter' && <Modal title="添加表具" onClose={() => setModal(null)}><form onSubmit={createMeter} className="form-stack"><Field label="表具名称"><input autoFocus name="name" placeholder="例如：厨房水表" required maxLength={50} /></Field><Field label="类型"><select name="kind"><option value="water">水表</option><option value="electricity">电表</option><option value="gas">燃气表</option></select></Field><Field label="计量单位"><input name="unit" placeholder="水/燃气 m³，电 kWh" /></Field><button className="primary-button">保存表具</button></form></Modal>}
    {modal === 'reading' && <Modal title="记录抄表读数" onClose={() => setModal(null)}>{data.meters.length === 0 ? <div className="empty-state"><Icon name="water_drop" size={30} /><p>先添加一块水、电或燃气表。</p><button className="primary-button" onClick={() => setModal('meter')}>添加表具</button></div> : <form onSubmit={createReading} className="form-stack"><Field label="选择表具"><select name="meterId">{data.meters.map((meter) => <option key={meter.id} value={meter.id}>{meter.name}</option>)}</select></Field><Field label="当前读数"><input autoFocus name="value" type="number" min="0" step="0.001" required placeholder="输入表盘数值" /></Field><Field label="抄表日期"><input name="date" type="date" defaultValue={today()} required /></Field><Field label="备注（可选）"><input name="note" placeholder="例如：本月账单金额" maxLength={200} /></Field><button className="primary-button">保存读数</button></form>}</Modal>}
    {modal === 'pet' && <Modal title="添加宠物档案" onClose={() => setModal(null)}><form onSubmit={createPet} className="form-stack"><Field label="宠物名字"><input autoFocus name="name" placeholder="怎么称呼它？" required maxLength={40} /></Field><Field label="种类"><input name="kind" placeholder="猫、狗或其他" defaultValue="猫咪" maxLength={40} /></Field><Field label="生日（可选）"><input name="birthday" type="date" /></Field><Field label="备注（可选）"><textarea name="note" rows={3} placeholder="品种、习惯或过敏信息" /></Field><button className="primary-button">保存档案</button></form></Modal>}
    {modal === 'pet-event' && <Modal title="添加宠物记录" onClose={() => setModal(null)}><form onSubmit={createPetEvent} className="form-stack"><Field label="宠物"><select name="petId">{data.pets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></Field><Field label="记录类型"><select name="kind"><option value="feeding">喂养</option><option value="weight">体重</option><option value="vaccine">疫苗</option><option value="deworming">驱虫</option><option value="visit">就诊</option><option value="custom">其他</option></select></Field><Field label="内容"><input autoFocus name="title" placeholder="例如：体重 4.2 kg" required maxLength={100} /></Field><Field label="记录日期"><input name="date" type="date" defaultValue={today()} required /></Field><Field label="提醒日期（可选）"><input name="reminderDate" type="date" /></Field><Field label="备注"><textarea name="note" rows={2} /></Field><button className="primary-button">保存记录</button></form></Modal>}
    {modal === 'import' && <Modal title="导入本机备份" onClose={() => { setModal(null); setPendingBackup(null); setImportError(''); }}><p className="modal-copy">先检查备份内容再确认导入。采用合并方式：相同记录 ID 会覆盖，其他本机数据保留；社区账号和线上内容不包含在备份中。</p><form onSubmit={inspectBackup} className="form-stack"><Field label="选择 JSON 备份文件（最大 20 MB）"><input name="backup" type="file" accept="application/json,.json" required onChange={() => { setPendingBackup(null); setImportError(''); }} /></Field><button className="soft-button">检查备份内容</button></form>{importError && <p className="form-error" role="alert">{importError}</p>}{pendingBackup && <section className="backup-preview"><h3>备份预览</h3><p>{pendingBackup.fileName} · 导出于 {new Date(pendingBackup.preview.exportedAt).toLocaleString('zh-CN')} · 共 {pendingBackup.preview.total} 条</p><div className="backup-preview-grid">{pendingBackup.preview.stores.filter((item) => item.count > 0).map((item) => <div key={item.store}><b>{item.label}</b><small>{item.count} 条 · 新增 {item.added} · 覆盖 {item.overwritten}</small></div>)}</div><button className="primary-button" type="button" onClick={() => void importBackup()}>确认合并导入</button></section>}</Modal>}
  </div>;
}

function localDayKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function HomePage({ lists, items, runs, templates, meters, readings, pets, events, onGo, onStartRun, onToggleRun, onAddReading }: { lists: Checklist[]; items: ChecklistItem[]; runs: CheckRun[]; templates: CheckTemplate[]; meters: Meter[]; readings: MeterReading[]; pets: Pet[]; events: PetEvent[]; onGo: (nav: NavKey) => void; onStartRun: (template: CheckTemplate) => void; onToggleRun: (run: CheckRun, itemId: string) => void; onAddReading: () => void }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const todayKey = localDayKey(clock);
  const hour = clock.getHours();
  const greeting = hour >= 5 && hour < 11 ? '早上好' : hour < 14 && hour >= 11 ? '中午好' : hour < 18 && hour >= 14 ? '下午好' : hour >= 18 && hour < 23 ? '晚上好' : '夜深了';
  const activeRuns = runs.filter((run) => !run.completedAt);
  const activeListIds = new Set(lists.filter((list) => !list.archivedAt).map((list) => list.id));
  const todayCompletedItems = items.filter((item) => activeListIds.has(item.checklistId) && item.done && localDayKey(new Date(item.completedAt ?? item.createdAt)) === todayKey);
  const todayItems = items.filter((item) => activeListIds.has(item.checklistId) && !item.done && (!item.dueDate || item.dueDate <= todayKey));
  const todayCompleted = todayCompletedItems.length;
  const todayScopeCount = todayItems.length + todayCompleted;
  const reading = readings.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  return <>
    <section className="welcome-row"><div><p className="eyebrow">慢一点，也能安排好</p><h1>{greeting}，<span>今天想先做哪件小事？</span></h1></div><div className="sun-badge"><Icon name={hour >= 18 || hour < 5 ? 'dark_mode' : 'wb_sunny'} size={24} /></div></section>
    <section className="hero-card"><div className="hero-content"><span className="eyebrow light-text">TODAY · {todayItems.length} 项待办</span><h2>先从一件小事开始</h2><p>今日完成 {todayCompleted} / {todayScopeCount} 项，给今天留一点从容。</p><div className="hero-progress"><i style={{ width: `${todayScopeCount ? Math.round(todayCompleted / todayScopeCount * 100) : 0}%` }} /></div></div><div className="hero-art"><Icon name="auto_awesome" size={70} /></div></section>
    <section className="home-section"><div className="section-heading"><div><p className="eyebrow">先看这一些</p><h2>今天要记得</h2></div><button className="text-button" onClick={() => onGo('lists')}>全部清单 <Icon name="arrow_forward" size={17} /></button></div>
      {todayItems.length === 0 ? <div className="inline-empty"><Icon name="task_alt" size={22} /><span>今天没有待办，享受一点空白时间吧。</span></div> : todayItems.slice(0, 4).map((item, index) => <div className="home-task" key={item.id}><span className={`task-icon tint-${index % 3}`}><Icon name={index === 0 ? 'pets' : index === 1 ? 'water_drop' : 'checklist'} /></span><div className="task-label"><b>{item.title}</b><small>{item.dueDate ? item.dueDate < today() ? `已逾期 · ${item.dueDate}` : item.dueDate : '未设置日期'}</small></div><Icon name="chevron_right" size={20} /></div>)}
    </section>
    {todayCompletedItems.length > 0 && <section className="home-section today-completed-section"><div className="section-heading"><div><p className="eyebrow">做过的每一步都算数</p><h2>今日已完成 <span className="completed-count">{todayCompleted}</span></h2></div></div><div className="today-completed-list">{todayCompletedItems.map((item) => <div className="today-completed-item" key={item.id}><Icon name="task_alt" size={21} /><span>{item.title}</span><small>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.completedAt ?? item.createdAt))}</small></div>)}</div></section>}
    <div className="dashboard-grid">
      <section className="surface-card"><div className="card-head"><span className="tile-icon blue"><Icon name="water_drop" /></span><button className="icon-button small" onClick={onAddReading} aria-label="记录抄表"><Icon name="add" size={20} /></button></div><p className="eyebrow">水电燃气</p><h3>{reading ? `${reading.value} ${meters.find((meter) => meter.id === reading.meterId)?.unit ?? ''}` : '还没有抄表记录'}</h3><p className="muted">{reading ? `${meters.find((meter) => meter.id === reading.meterId)?.name ?? '表具'} · ${reading.date}` : '添加表具，轻松记录每月用量'}</p><button className="subtle-button" onClick={() => onGo('records')}>查看记录 <Icon name="arrow_forward" size={16} /></button></section>
      <section className="surface-card"><div className="card-head"><span className="tile-icon pink"><Icon name="pets" /></span><button className="icon-button small" onClick={() => onGo('records')} aria-label="查看宠物"><Icon name="arrow_forward" size={19} /></button></div><p className="eyebrow">宠物照护</p><h3>{pets.length ? `${pets.length} 位小伙伴` : '给毛孩子建个档案'}</h3><p className="muted">{events.length ? `${events[0].title} · ${reminderLabel(events[0].reminderDate)}` : '记录喂养、体重和重要日期'}</p><button className="subtle-button" onClick={() => onGo('records')}>宠物记录 <Icon name="arrow_forward" size={16} /></button></section>
    </div>
    <section className="home-section"><div className="section-heading"><div><p className="eyebrow">出门不遗漏</p><h2>随手开始检查</h2></div><button className="text-button" onClick={() => onGo('lists')}>管理模板 <Icon name="arrow_forward" size={17} /></button></div>
      <div className="template-row">{activeRuns.map((run) => <div className="run-card" key={run.id}><b>{run.title}</b><small>{run.items.filter((item) => item.done).length}/{run.items.length} 项完成</small><div className="run-items">{run.items.map((item) => <label key={item.id} className={item.done ? 'checked' : ''}><input type="checkbox" checked={item.done} onChange={() => onToggleRun(run, item.id)} />{item.title}</label>)}</div></div>)}{templates.slice(0, 3).map((template) => <button className="template-card" key={template.id} onClick={() => onStartRun(template)}><span className="tile-icon amber"><Icon name="door_open" /></span><b>{template.title}</b><small>{template.items.length} 项检查</small><span className="open-circle"><Icon name="arrow_outward" size={17} /></span></button>)}</div>
    </section>
  </>;
}

function ListsPage({ lists, listItems, templates, runs, selected, setSelected, onNewList, onNewItem, onToggleItem, onNewTemplate, onStartRun, onToggleRun, onExample, onRename, onArchive, onDelete, onEditTemplate, onCopyTemplate, onDeleteTemplate }: { lists: Checklist[]; listItems: ChecklistItem[]; templates: CheckTemplate[]; runs: CheckRun[]; selected: string | null; setSelected: (id: string | null) => void; onNewList: () => void; onNewItem: (listId: string) => void; onToggleItem: (item: ChecklistItem) => void; onNewTemplate: () => void; onStartRun: (template: CheckTemplate) => void; onToggleRun: (run: CheckRun, itemId: string) => void; onExample: (kind: 'travel' | 'move') => void; onRename: (list: Checklist) => void; onArchive: (list: Checklist) => void; onDelete: (list: Checklist) => void; onEditTemplate: (template: CheckTemplate) => void; onCopyTemplate: (template: CheckTemplate) => void; onDeleteTemplate: (template: CheckTemplate) => void }) {
  const activeLists = lists.filter((list) => !list.archivedAt);
  const archivedLists = lists.filter((list) => list.archivedAt);
  const sourceLists = [...activeLists, ...archivedLists];
  const chosen = selected && sourceLists.some((list) => list.id === selected) ? selected : activeLists[0]?.id ?? archivedLists[0]?.id;
  const currentList = lists.find((list) => list.id === chosen);
  const currentItems = listItems.filter((item) => item.checklistId === chosen).sort((a, b) => Number(a.done) - Number(b.done));
  return <>
    <PageTitle eyebrow="把事情放在清单里" title="生活清单" action={<button className="primary-button compact" onClick={onNewList}><Icon name="add" />新建清单</button>} />
    <div className="subnav-tabs"><button className="selected">待办清单</button><button onClick={() => document.getElementById('check-section')?.scrollIntoView({ behavior: 'smooth' })}>出门检查</button></div>
    {activeLists.length === 0 && archivedLists.length === 0 ? <><EmptyCard icon="checklist" title="从一张清单开始" detail="把旅行、搬家或每天要办的小事记下来。" action={<button className="primary-button" onClick={onNewList}>创建第一张清单</button>} /><div className="example-picks"><button className="soft-button" onClick={() => onExample('travel')}>添加旅行示例</button><button className="soft-button" onClick={() => onExample('move')}>添加搬家示例</button></div></> : <div className="list-layout"><aside className="list-picker">{sourceLists.map((list) => <button key={list.id} className={list.id === chosen ? 'chosen' : ''} onClick={() => setSelected(list.id)}><Icon name={list.archivedAt ? 'inventory_2' : 'folder_open'} size={19} /><span>{list.title}</span><small>{listItems.filter((item) => item.checklistId === list.id && !item.done).length}</small></button>)}{activeLists.length > 0 && archivedLists.length > 0 && <div className="picker-divider">已归档</div>}</aside><section className="surface-card list-detail"><div className="list-heading"><div><p className="eyebrow">{currentItems.filter((item) => item.done).length} / {currentItems.length} 已完成 {currentList?.archivedAt && '· 已归档'}</p><h2>{currentList?.title}</h2></div><div className="list-actions">{currentList && <><button className="icon-button small" aria-label="编辑清单名称" onClick={() => onRename(currentList)}><Icon name="edit" size={18} /></button><button className="icon-button small" aria-label={currentList.archivedAt ? '恢复清单' : '归档清单'} onClick={() => onArchive(currentList)}><Icon name={currentList.archivedAt ? 'unarchive' : 'archive'} size={18} /></button><button className="icon-button small danger-icon" aria-label="删除清单" onClick={() => onDelete(currentList)}><Icon name="delete" size={18} /></button></>}{!currentList?.archivedAt && <button className="primary-button compact" onClick={() => chosen && onNewItem(chosen)}><Icon name="add" />添加事项</button>}</div></div><div className="list-progress"><i style={{ width: `${currentItems.length ? currentItems.filter((item) => item.done).length / currentItems.length * 100 : 0}%` }} /></div>{currentItems.length === 0 ? <div className="inline-empty">这张清单还空着，添加第一件事吧。</div> : currentItems.map((item) => <label key={item.id} className={`check-row ${item.done ? 'done' : ''}`}><input type="checkbox" checked={item.done} onChange={() => onToggleItem(item)} /><span className="checkmark"><Icon name="check" size={16} /></span><span className="check-copy"><b>{item.title}</b>{(item.dueDate || item.note) && <small>{[item.dueDate, item.note].filter(Boolean).join(' · ')}</small>}</span></label>)}</section></div>}
    <section id="check-section" className="home-section"><div className="section-heading"><div><p className="eyebrow">出门更从容</p><h2>出门检查</h2></div><button className="text-button" onClick={onNewTemplate}><Icon name="add" />新建模板</button></div><div className="template-row">{templates.map((template) => { const active = runs.find((run) => run.templateId === template.id && !run.completedAt); return <div className="template-card template-detail" key={template.id}><div className="template-tools"><button aria-label="编辑模板" onClick={() => onEditTemplate(template)}><Icon name="edit" size={17} /></button><button aria-label="复制模板" onClick={() => onCopyTemplate(template)}><Icon name="content_copy" size={17} /></button><button aria-label="删除模板" onClick={() => onDeleteTemplate(template)}><Icon name="delete" size={17} /></button></div><span className="tile-icon amber"><Icon name="door_open" /></span><b>{template.title}</b><small>{template.items.length} 项 · {active ? '进行中' : '准备好了'}</small>{active ? <div className="run-items">{active.items.map((item) => <label key={item.id} className={item.done ? 'checked' : ''}><input type="checkbox" checked={item.done} onChange={() => onToggleRun(active, item.id)} />{item.title}</label>)}</div> : <button className="subtle-button" onClick={() => onStartRun(template)}>开始检查 <Icon name="arrow_forward" size={16} /></button>}</div>; })}</div></section>
  </>;
}

function RecordsPage({ tab, setTab, meters, readings, pets, events, onAddMeter, onAddReading, onAddPet, onAddPetEvent, onToggleEvent }: { tab: 'utilities' | 'pets'; setTab: (tab: 'utilities' | 'pets') => void; meters: Meter[]; readings: MeterReading[]; pets: Pet[]; events: PetEvent[]; onAddMeter: () => void; onAddReading: () => void; onAddPet: () => void; onAddPetEvent: () => void; onToggleEvent: (event: PetEvent) => void }) {
  return <>
    <PageTitle eyebrow="把重要日常轻轻记下" title="生活记录" />
    <div className="subnav-tabs"><button className={tab === 'utilities' ? 'selected' : ''} onClick={() => setTab('utilities')}><Icon name="water_drop" size={18} />水电燃气</button><button className={tab === 'pets' ? 'selected' : ''} onClick={() => setTab('pets')}><Icon name="pets" size={18} />宠物日常</button></div>
    {tab === 'utilities' ? <><div className="section-heading"><div><p className="eyebrow">每次抄表都会保留下来</p><h2>我的表具</h2></div><div className="button-pair"><button className="soft-button" onClick={onAddMeter}><Icon name="add" />添加表具</button><button className="primary-button compact" onClick={onAddReading}><Icon name="edit_note" />记读数</button></div></div>{meters.length === 0 ? <EmptyCard icon="water_drop" title="添加第一块表具" detail="手动记录读数，自动计算相邻两次的用量。" action={<button className="primary-button" onClick={onAddMeter}>添加表具</button>} /> : <div className="record-grid">{meters.map((meter) => { const history = readings.filter((reading) => reading.meterId === meter.id).sort((a, b) => b.date.localeCompare(a.date)); const latest = history[0]; const previous = history[1]; return <article className="surface-card meter-card" key={meter.id}><div className="card-head"><span className={`tile-icon ${meter.kind === 'water' ? 'blue' : meter.kind === 'electricity' ? 'amber' : 'pink'}`}><Icon name={meter.kind === 'water' ? 'water_drop' : meter.kind === 'electricity' ? 'bolt' : 'local_fire_department'} /></span><span className="kind-chip">{meter.kind === 'water' ? '水表' : meter.kind === 'electricity' ? '电表' : '燃气表'}</span></div><p className="eyebrow">{meter.name}</p><h3>{latest ? `${latest.value} ${meter.unit}` : '等待首次抄表'}</h3><p className="muted">{latest ? `${latest.date}${previous ? ` · 上期用量 ${(latest.value - previous.value).toFixed(2)} ${meter.unit}` : ''}` : '添加一条读数开始记录'}</p>{history.slice(0, 5).map((reading) => <div className="history-line" key={reading.id}><span>{reading.date}</span><b>{reading.value} {meter.unit}</b></div>)}</article>; })}</div>}</> : <><div className="section-heading"><div><p className="eyebrow">它们的日常，也值得好好记录</p><h2>宠物档案</h2></div><div className="button-pair"><button className="soft-button" onClick={onAddPet}><Icon name="add" />添加宠物</button>{pets.length > 0 && <button className="primary-button compact" onClick={onAddPetEvent}><Icon name="edit_note" />记一件事</button>}</div></div>{pets.length === 0 ? <EmptyCard icon="pets" title="给毛孩子建个小档案" detail="保存基本信息，再记录喂养、体重、疫苗和重要日期。" action={<button className="primary-button" onClick={onAddPet}>添加宠物档案</button>} /> : <div className="record-grid pet-grid">{pets.map((pet) => { const petHistory = events.filter((event) => event.petId === pet.id).sort((a, b) => b.date.localeCompare(a.date)); return <article className="surface-card pet-card" key={pet.id}><div className="pet-avatar"><Icon name="pets" size={27} /></div><p className="eyebrow">{pet.kind}{pet.birthday ? ` · ${pet.birthday} 生日` : ''}</p><h3>{pet.name}</h3>{pet.note && <p className="muted">{pet.note}</p>}<div className="pet-history">{petHistory.length ? petHistory.slice(0, 5).map((event) => <div className="history-line" key={event.id}><span><Icon name={event.completed ? 'task_alt' : 'event'} size={16} />{event.title}</span><b>{event.date}</b></div>) : <p className="muted">还没有日常记录</p>}</div></article>; })}</div>}{events.length > 0 && <section className="home-section"><div className="section-heading"><div><p className="eyebrow">要记得的事情</p><h2>宠物提醒</h2></div></div>{events.filter((event) => !event.completed).map((event) => <div className="home-task" key={event.id}><span className="task-icon tint-2"><Icon name="notifications_active" /></span><div className="task-label"><b>{event.title}</b><small>{pets.find((pet) => pet.id === event.petId)?.name} · {reminderLabel(event.reminderDate)}</small></div><button className="soft-button" onClick={() => onToggleEvent(event)}>完成</button></div>)}</section>}</>}
  </>;
}

function ProfilePage({ session, view, setView, onMessage, onTheme, onExport, onImport, onClear, onOpenCommunityProfile }: { session: Session | null; view: ProfileView; setView: (view: ProfileView) => void; onMessage: (message: string) => void; onTheme: () => Promise<void>; onExport: () => void; onImport: () => void; onClear: () => void; onOpenCommunityProfile: (userId: string) => void }) {
  const [accountProfile, setAccountProfile] = useState<CommunityProfile | null>(null);
  const [followingCount, setFollowingCount] = useState(0);
  const [postCount, setPostCount] = useState(0);
  const effective = document.documentElement.dataset.theme === 'dark' ? '夜间' : '日间';

  useEffect(() => {
    if (!session || !supabase) { setAccountProfile(null); setFollowingCount(0); setPostCount(0); return; }
    let active = true;
    void (async () => {
      const [profileResult, followingResult, postResult] = await Promise.all([
        supabase.from('profiles').select('id,username,display_name,avatar_path,bio,role,account_status').eq('id', session.user.id).maybeSingle(),
        supabase.from('follows').select('followee_id', { count: 'exact', head: true }).eq('follower_id', session.user.id),
        supabase.from('posts').select('id', { count: 'exact', head: true }).eq('author_id', session.user.id).in('moderation_status', ['visible', 'hidden'])
      ]);
      const { data, error } = profileResult;
      if (error) { if (active) onMessage(error.message); return; }
      const value = data as CommunityProfile | null;
      if (value?.avatar_path) {
        const { data: signed } = await supabase.storage.from('community-media').createSignedUrl(value.avatar_path, 3600);
        value.avatar_url = signed?.signedUrl;
      }
      if (active) { setAccountProfile(value); setFollowingCount(followingResult.count ?? 0); setPostCount(postResult.count ?? 0); }
    })();
    return () => { active = false; };
  }, [session?.user.id, onMessage]);

  useEffect(() => {
    if (['account', 'edit-profile', 'following', 'posts', 'delete-account', 'logout'].includes(view) && !session) setView('home');
  }, [view, session, setView]);

  if (view === 'auth') return <div className="profile-subpage"><AuthPage onBack={() => setView('home')} onMessage={onMessage} onAuthenticated={() => setView('home')} /></div>;
  if (view === 'account' && session) return <div className="profile-subpage"><button className="soft-button profile-back" type="button" onClick={() => setView('home')}><Icon name="arrow_back" />返回我的</button><PageTitle eyebrow="ACCOUNT SETTINGS" title="账号设置" /><AccountSettings session={session} onMessage={onMessage} onProfileChange={setAccountProfile} onNavigate={setView} /></div>;
  if (view === 'edit-profile' && session) return <div className="profile-subpage"><button className="soft-button profile-back" type="button" onClick={() => setView('account')}><Icon name="arrow_back" />返回账号设置</button><PageTitle eyebrow="PROFILE" title="编辑个人资料" /><ProfileEditPage session={session} onMessage={onMessage} onProfileChange={setAccountProfile} onComplete={() => setView('account')} /></div>;
  if (view === 'change-password' && session) return <div className="profile-subpage"><button className="soft-button profile-back" type="button" onClick={() => setView('account')}><Icon name="arrow_back" />返回账号设置</button><PasswordChangePage session={session} onMessage={onMessage} onComplete={() => setView('auth')} /></div>;
  if (view === 'delete-account' && session) return <div className="profile-subpage"><button className="soft-button profile-back" type="button" onClick={() => setView('account')}><Icon name="arrow_back" />返回账号设置</button><PageTitle eyebrow="ACCOUNT SECURITY" title="注销账号" /><DeleteAccountPage onMessage={onMessage} onComplete={() => setView('home')} /></div>;
  if (view === 'logout' && session) return <div className="profile-subpage"><button className="soft-button profile-back" type="button" onClick={() => setView('account')}><Icon name="arrow_back" />返回账号设置</button><PageTitle eyebrow="ACCOUNT SECURITY" title="退出登录" /><LogoutAccountPage onMessage={onMessage} onComplete={() => setView('home')} /></div>;
  if (view === 'following' && session) return <FollowingPage session={session} onBack={() => setView('home')} onOpenProfile={onOpenCommunityProfile} onMessage={onMessage} />;
  if (view === 'posts' && session) return <MyPostsPage session={session} onBack={() => setView('home')} onMessage={onMessage} />;

  return <><PageTitle eyebrow="只属于你的生活空间" title="我的" /><button className="profile-account-entry" type="button" onClick={() => setView(session ? 'account' : 'auth')} aria-label={session ? `账号设置：${accountProfile?.display_name ?? '账号用户'}` : '登录或注册'}><span className="profile-account-avatar">{session && (accountProfile?.avatar_url ? <img src={accountProfile.avatar_url} alt="" /> : <Icon name="person" size={29} />)}</span><span className="profile-account-copy"><span className="profile-account-name">{session ? accountProfile?.display_name || '账号用户' : '登录/注册'}</span></span></button>{session && <section className="profile-community-shortcuts" aria-label="社区个人入口"><button className="profile-community-link" type="button" onClick={() => setView('following')}><span className="profile-shortcut-icon"><Icon name="group" /></span><span><b>我的关注</b><small>查看关注的人</small></span><span className="profile-shortcut-count">{followingCount}</span><Icon name="chevron_right" /></button><button className="profile-community-link" type="button" onClick={() => setView('posts')}><span className="profile-shortcut-icon posts"><Icon name="article" /></span><span><b>我的动态</b><small>查看、编辑或删除我的发布</small></span><span className="profile-shortcut-count">{postCount}</span><Icon name="chevron_right" /></button></section>}<section className="settings-group"><h2>偏好设置</h2><button className="settings-row" onClick={() => void onTheme()}><span className="settings-icon"><Icon name={effective === '夜间' ? 'dark_mode' : 'light_mode'} /></span><span><b>外观主题</b><small>{effective} · 点击切换</small></span><Icon name="chevron_right" /></button><div className="settings-row static"><span className="settings-icon blue"><Icon name="cloud_off" /></span><span><b>数据保存</b><small>清单、抄表和宠物记录保存在本机</small></span></div></section><section className="settings-group"><h2>数据与备份</h2><button className="settings-row" onClick={onExport}><span className="settings-icon green"><Icon name="download" /></span><span><b>导出备份</b><small>保存一份 JSON 文件到设备</small></span><Icon name="chevron_right" /></button><button className="settings-row" onClick={onImport}><span className="settings-icon amber"><Icon name="upload_file" /></span><span><b>导入备份</b><small>合并恢复之前导出的数据</small></span><Icon name="chevron_right" /></button><button className="settings-row danger-row" onClick={onClear}><span className="settings-icon red"><Icon name="delete" /></span><span><b>清除本机记录</b><small>删除全部清单、表具和宠物记录</small></span><Icon name="chevron_right" /></button></section><section className="settings-group"><h2>关于</h2><div className="settings-row static"><span className="settings-icon"><Icon name="info" /></span><span><b>日常有序</b><small>本机生活管理 · 生活社区</small></span><span className="version-chip">v0.1</span></div></section></>;
}

function PageTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) { return <div className="page-title-row"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action}</div>; }
function EmptyCard({ icon, title, detail, action }: { icon: string; title: string; detail: string; action: ReactNode }) { return <div className="empty-card"><span className="empty-icon"><Icon name={icon} size={27} /></span><h3>{title}</h3><p>{detail}</p>{action}</div>; }
