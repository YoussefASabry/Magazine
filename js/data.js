/**
 * Shared data layer for The Rising Times.
 *
 * With Supabase configured it reads/writes the database. Without config it
 * falls back to the legacy JSON files in read-only mode so the site still runs.
 */

const DEFAULT_SETTINGS = {
  site: {
    name: 'The Rising Times',
    school: 'Rising Stars Language School',
    system: 'Futures Education System'
  },
  hero: {
    title: 'The Rising Times',
    subtitle: 'The Official Digital Magazine of Rising Stars Language School',
    readMore: 'Read News'
  },
  about: {
    text:
      "This website was conceived and built by the Cultural, Scientific & Educational Council (CSE) of Rising Stars Language School. This digital magazine is to showcase our school's achievements & all of our students' perseverance to keep learning and getting better.",
    cta: 'Visit CSE Council'
  },
  school: {
    items: [
      'Private school owned by futures education system',
      'Modern school with smart boards and science labs',
      'Beautiful garden for student activities',
      'Committed to excellence and innovation'
    ]
  },
  social: {
    instagram: 'https://www.instagram.com/risingtimesofficial?igsh=MW5zdmk3dnA4OTVvbw==',
    facebook: 'https://www.facebook.com/RisingStars.6thofOctober/'
  },
  videos: {
    main: 'https://youtu.be/hDmSL2mo4b4?si=aifXbCBIoHW100_T',
    secondary: 'https://youtu.be/VBsYzKxRdEA?si=A5tMzBfgJcRrWr9L'
  },
  footer: {
    tagline:
      'The Rising Times is the premier source for Rising News and student achievements at Rising Stars Language School. Explore our digital magazine for the latest updates from Rising Stars.',
    copyright: '© 2026 All Rights Reserved'
  },
  seo: {
    title: 'The Rising Times | Rising Stars News & Language School Magazine',
    description:
      'Official school news magazine for Rising Stars Language School, The Rising Times. Featuring student achievements, academic competitions, and Rising Stars news updates.',
    keywords:
      'Rising Stars, School Magazine, The Rising Times, Student Achievements, CSE Council, Rising Stars News',
    ogImage: 'assets/images/logo1.png'
  },
  team: {
    slugs: [
      'youssef-ahmed-sabry',
      'ahmed-alaadin-hassan',
      'yassin-ahmed-sabry',
      'lili-ahmed',
      'ahmed-adel-abd-elhafeez'
    ]
  },
  student_priority: {
    slugs: [
      'youssef-ahmed-sabry',
      'ahmed-alaadin-hassan',
      'yassin-ahmed-sabry',
      'lili-ahmed',
      'ahmed-adel-abd-elhafeez'
    ]
  }
};

const STAGES = ['secondary', 'preparatory', 'primary'];
const CSE_ROLES = ['president', 'vicePresident', 'science', 'religiousCulture', 'art', 'social', 'sports'];

const emptyStages = () => {
  const stages = {};
  for (const stage of STAGES) {
    stages[stage] = {};
    for (const role of CSE_ROLES) stages[stage][role] = '';
  }
  return stages;
};

const config = window.MAGAZINE_CONFIG || {};
const hasSupabase = Boolean(
  config.supabaseUrl && config.supabaseAnonKey && window.supabase?.createClient
);
const client = hasSupabase
  ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    })
  : null;

const state = {
  events: [],
  students: [],
  cse: { head: 'Miss Somia', headId: null, stages: emptyStages() },
  settings: {},
  session: null,
  profile: null,
  loaded: false,
  admin: false,
  readOnly: !client,
  error: null
};

const plainText = (html) =>
  String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

function normalizeStudent(row) {
  return {
    id: row.slug,
    uuid: row.id,
    slug: row.slug,
    name: row.name || '',
    role: row.role || '',
    quote: row.quote || '',
    image: row.image_url || '',
    star: Boolean(row.star),
    type: row.type || 'student',
    class: row.class_level || (row.type === 'teacher' ? 'Teacher' : ''),
    class_level: row.class_level || null,
    achievements: row.achievements || [],
    is_top: Boolean(row.is_top),
    top_role: row.top_role || '',
    sort_order: row.sort_order ?? 0,
    deleted_at: row.deleted_at || null
  };
}

function normalizePerson(row, studentsByUuid) {
  const student = row.student_id ? studentsByUuid.get(row.student_id) : null;
  return {
    student_id: row.student_id || null,
    slug: student?.slug || '',
    name: row.name_snapshot || student?.name || '',
    role: row.role || '',
    achievement: row.achievement || '',
    image: student?.image_url || '',
    star: Boolean(student?.star),
    type: student?.type || 'student',
    class: student?.class_level || ''
  };
}

function normalizeElement(row, people) {
  const element = {
    ...(row.data || {}),
    uuid: row.id,
    type: row.type,
    position: row.position ?? 0
  };

  if (row.type === 'students') {
    element.students = people.map((person) => normalizePerson(person, state._studentsByUuid));
  }
  if (row.type === 'organizers') {
    element.organizers = people.map((person) => normalizePerson(person, state._studentsByUuid));
  }
  return element;
}

function normalizeEvent(row, elements) {
  return {
    id: row.slug,
    uuid: row.id,
    slug: row.slug,
    title: row.title || '',
    category: row.category || 'School',
    date: row.date_label || '',
    event_date: row.event_date || null,
    featured: Boolean(row.featured),
    status: row.status || 'draft',
    sort_order: row.sort_order ?? 0,
    cover_image_url: row.cover_image_url || '',
    seo_title: row.seo_title || '',
    seo_description: row.seo_description || '',
    og_image_url: row.og_image_url || '',
    deleted_at: row.deleted_at || null,
    published_at: row.published_at || null,
    elements
  };
}

const DataStore = {
  client,
  readOnly: !client,

  async load(options = {}) {
    const admin = options.admin ?? state.admin;
    if (state.loaded && state.admin === admin && !options.force) return;

    state.error = null;
    try {
      if (client) await this._loadSupabase(admin);
      else await this._loadFallback();
      state.admin = admin;
      state.loaded = true;
      state.readOnly = !client;
      this.readOnly = !client;
    } catch (error) {
      state.error = error;
      throw error;
    }
  },

  async reload(options = {}) {
    state.loaded = false;
    return this.load({ admin: options.admin ?? state.admin, force: true });
  },

  async _loadSupabase(admin) {
    const { data: sessionData } = await client.auth.getSession();
    state.session = sessionData?.session || null;

    let eventsQuery = client
      .from('events')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (!admin) eventsQuery = eventsQuery.eq('status', 'published').is('deleted_at', null);

    let studentsQuery = client
      .from('students')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (!admin) studentsQuery = studentsQuery.is('deleted_at', null);

    const [eventsResult, studentsResult, cseResult, settingsResult] = await Promise.all([
      eventsQuery,
      studentsQuery,
      client.from('cse_positions').select('*'),
      client.from('site_settings').select('key, value')
    ]);

    for (const result of [eventsResult, studentsResult, cseResult, settingsResult]) {
      if (result.error) throw new Error(result.error.message);
    }

    const studentRows = studentsResult.data || [];
    const students = studentRows.map(normalizeStudent);
    const studentsByUuid = new Map(studentRows.map((row) => [row.id, row]));
    state._studentsByUuid = studentsByUuid;

    const eventRows = eventsResult.data || [];
    const eventIds = eventRows.map((row) => row.id);
    let elementRows = [];

    if (eventIds.length) {
      const { data, error } = await client
        .from('event_elements')
        .select('*')
        .in('event_id', eventIds)
        .order('position', { ascending: true });
      if (error) throw new Error(error.message);
      elementRows = data || [];
    }

    const elementIds = elementRows.map((row) => row.id);
    let peopleRows = [];

    if (elementIds.length) {
      const { data, error } = await client
        .from('event_people')
        .select('*')
        .in('element_id', elementIds)
        .order('position', { ascending: true });
      if (error) throw new Error(error.message);
      peopleRows = data || [];
    }

    const peopleByElement = new Map();
    for (const person of peopleRows) {
      if (!peopleByElement.has(person.element_id)) peopleByElement.set(person.element_id, []);
      peopleByElement.get(person.element_id).push(person);
    }

    const elementsByEvent = new Map();
    for (const elementRow of elementRows) {
      if (!elementsByEvent.has(elementRow.event_id)) elementsByEvent.set(elementRow.event_id, []);
      elementsByEvent
        .get(elementRow.event_id)
        .push(normalizeElement(elementRow, peopleByElement.get(elementRow.id) || []));
    }

    state.students = students;
    state.events = eventRows.map((row) =>
      normalizeEvent(row, elementsByEvent.get(row.id) || [])
    );

    const settings = {};
    for (const row of settingsResult.data || []) settings[row.key] = row.value;
    state.settings = settings;

    const cse = { head: 'Miss Somia', headId: null, stages: emptyStages() };
    for (const position of cseResult.data || []) {
      const student = position.student_id ? studentsByUuid.get(position.student_id) : null;
      if (cse.stages[position.stage]) {
        cse.stages[position.stage][position.role] = student?.name || '';
      }
    }

    const headSetting = settings.cse_head || {};
    const headStudent = headSetting.student_id ? studentsByUuid.get(headSetting.student_id) : null;
    cse.head = headStudent?.name || headSetting.name || 'Miss Somia';
    cse.headId = headStudent?.id || null;
    state.cse = cse;

    if (admin && state.session) {
      const { data: profile } = await client
        .from('profiles')
        .select('id, display_name, role')
        .eq('id', state.session.user.id)
        .maybeSingle();
      state.profile = profile || null;
    }
  },

  async _loadFallback() {
    const stamp = Date.now();
    const [eventsResponse, studentsResponse] = await Promise.all([
      fetch(`data/events.json?_=${stamp}`, { cache: 'no-store' }),
      fetch(`data/students.json?_=${stamp}`, { cache: 'no-store' })
    ]);
    if (!eventsResponse.ok || !studentsResponse.ok) {
      throw new Error('Could not load the magazine data.');
    }

    const eventsJson = await eventsResponse.json();
    const studentsJson = await studentsResponse.json();
    const topNames = new Set((studentsJson.topStudents || []).map((item) => item.name));
    const topRoles = new Map((studentsJson.topStudents || []).map((item) => [item.name, item.role]));

    state._studentsByUuid = new Map();
    state.students = (studentsJson.students || []).map((student, index) => ({
      id: student.id || Utils.slugify(student.name),
      uuid: null,
      slug: student.id || Utils.slugify(student.name),
      name: student.name,
      role: student.role || '',
      quote: student.quote || '',
      image: student.image || '',
      star: Boolean(student.star),
      type: student.type || 'student',
      class: student.type === 'teacher' ? 'Teacher' : student.class || '',
      class_level: student.type === 'teacher' ? null : student.class || null,
      achievements: student.achievements || [],
      is_top: topNames.has(student.name),
      top_role: topRoles.get(student.name) || '',
      sort_order: index,
      deleted_at: null
    }));

    state.events = (eventsJson.events || []).map((event, index) => ({
      id: event.id,
      uuid: null,
      slug: event.id,
      title: event.title,
      category: event.category || 'School',
      date: event.date || '',
      event_date: null,
      featured: Boolean(event.featured),
      status: 'published',
      sort_order: index,
      cover_image_url: this._previewFromElements(event.elements),
      seo_title: '',
      seo_description: '',
      og_image_url: '',
      deleted_at: null,
      published_at: null,
      elements: event.elements || []
    }));

    const council = eventsJson.cseCouncil || {};
    state.cse = {
      head: council.head || 'Miss Somia',
      headId: null,
      stages: { ...emptyStages(), ...(council.stages || {}) }
    };
    for (const stage of STAGES) {
      state.cse.stages[stage] = { ...emptyStages()[stage], ...(council.stages?.[stage] || {}) };
    }

    state.settings = {};
    state.session = null;
    state.profile = null;
  },

  _previewFromElements(elements) {
    for (const element of elements || []) {
      if (element.type === 'image' && element.image) return element.image;
      if (element.type === 'slideshow' && element.images?.length) return element.images[0];
    }
    return '';
  },

  getSettings(key, fallback) {
    const value = state.settings[key];
    const base = fallback !== undefined ? fallback : DEFAULT_SETTINGS[key];
    if (value === undefined || value === null) return base;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base &&
      typeof base === 'object' &&
      !Array.isArray(base)
    ) {
      return { ...base, ...value };
    }
    return value;
  },

  applySiteMeta() {
    const seo = this.getSettings('seo');
    if (seo.title) document.title = seo.title;

    const setMeta = (attribute, name, content) => {
      if (!content) return;
      let tag = document.querySelector(`meta[${attribute}="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute(attribute, name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    setMeta('name', 'description', seo.description);
    setMeta('name', 'keywords', seo.keywords);
    setMeta('property', 'og:title', seo.title);
    setMeta('property', 'og:description', seo.description);
    setMeta('property', 'og:image', seo.ogImage);
    setMeta('property', 'og:url', config.siteUrl || window.location.href);
    setMeta('property', 'og:type', 'website');
  },

  getEvents(options = {}) {
    let events = state.events;
    if (!options.includeDeleted) events = events.filter((event) => !event.deleted_at);
    if (!options.includeDrafts) events = events.filter((event) => event.status === 'published');
    return [...events];
  },

  getEvent(id) {
    if (!id) return null;
    return (
      state.events.find(
        (event) => event.id === id || event.slug === id || event.uuid === id
      ) || null
    );
  },

  getStudents(options = {}) {
    let students = state.students;
    if (!options.includeDeleted) students = students.filter((student) => !student.deleted_at);
    return [...students];
  },

  getStudent(value, options = {}) {
    if (!value) return null;
    const key = String(value).toLowerCase();
    return (
      this.getStudents(options).find(
        (student) =>
          student.slug === value ||
          student.id === value ||
          student.uuid === value ||
          student.name.toLowerCase() === key
      ) || null
    );
  },

  getStudentBySlug(slug) {
    return this.getStudent(slug);
  },

  getTopStudents() {
    return this.getStudents()
      .filter((student) => student.is_top)
      .map((student) => ({
        name: student.name,
        role: student.top_role || 'Top Student',
        slug: student.slug
      }));
  },

  getStarStudents() {
    return this.getStudents().filter((student) => student.star);
  },

  getCSECouncil() {
    return state.cse;
  },

  getProfile() {
    return state.profile;
  },

  getCSEHead() {
    return state.cse.head || 'Miss Somia';
  },

  getTeamStudents() {
    const slugs = this.getSettings('team').slugs || [];
    const students = slugs.map((slug) => this.getStudent(slug)).filter(Boolean);
    if (students.length) return students;

    const names = [
      'Youssef Ahmed Sabry',
      'Ahmed Alaadin Hassan Darmelli',
      'Yassin Ahmed Sabry',
      'Lily Ahmed',
      'Ahmed Adel Abd Elhafeez'
    ];
    return names.map((name) => this.getStudent(name)).filter(Boolean);
  },

  getPriorityStudents() {
    const slugs = this.getSettings('student_priority').slugs || [];
    return slugs.map((slug) => this.getStudent(slug)).filter(Boolean);
  },

  getEventPreviewImage(event) {
    if (event?.cover_image_url) return event.cover_image_url;
    return this._previewFromElements(event?.elements);
  },

  getEventExcerpt(event) {
    const textElement = (event?.elements || []).find(
      (element) => element.type === 'text' && element.content
    );
    return Utils.truncate(plainText(textElement?.content || ''), 160);
  },

  getEventStudents(event) {
    const result = [];
    for (const element of event?.elements || []) {
      if (element.type === 'students' && element.students) result.push(...element.students);
    }
    return result;
  },

  getStudentEvents(studentRef) {
    const student = this.getStudent(studentRef);
    if (!student) return [];

    const matches = (person) => {
      if (student.uuid && person.student_id) return person.student_id === student.uuid;
      return (person.name || '').toLowerCase() === student.name.toLowerCase();
    };

    const events = this.getEvents().filter((event) => {
      if (event.id === 'top-students-competition') return false;
      return (event.elements || []).some((element) => {
        if (element.type === 'students' && element.students) {
          return element.students.some(matches);
        }
        if (element.type === 'organizers' && element.organizers) {
          return element.organizers.some(matches);
        }
        return false;
      });
    });

    const council = this.getCSECouncil();
    let cseRole = null;

    if (council.head && council.head.toLowerCase() === student.name.toLowerCase()) {
      cseRole = { key: 'head', title: 'Council Head', icon: '👑' };
    } else {
      const roleMap = {
        president: { title: 'Stage President', icon: '👑' },
        vicePresident: { title: 'Vice President', icon: '⭐' },
        science: { title: 'Science Representative', icon: '🔬' },
        religiousCulture: { title: 'Religious & Culture Representative', icon: '🕌' },
        art: { title: 'Art Representative', icon: '🎨' },
        social: { title: 'Social Representative', icon: '🤝' },
        sports: { title: 'Sports Representative', icon: '🏆' }
      };
      const stageLabel = { secondary: 'Secondary', preparatory: 'Preparatory', primary: 'Primary' };

      for (const stage of STAGES) {
        for (const roleKey of CSE_ROLES) {
          const memberName = council.stages[stage]?.[roleKey];
          if (memberName && memberName.toLowerCase() === student.name.toLowerCase()) {
            const info = roleMap[roleKey] || { title: 'Member', icon: '👤' };
            cseRole = {
              key: roleKey,
              title: `${stageLabel[stage]} ${info.title}`,
              icon: info.icon,
              stage
            };
            break;
          }
        }
        if (cseRole) break;
      }
    }

    if (cseRole) {
      events.unshift({
        id: 'cse-council-event',
        title: 'CSE Council',
        featured: false,
        elements: [{ type: 'text', content: 'CSE Council Member' }],
        _isCSE: true,
        _cseRole: cseRole
      });
    }

    const topStudent = this.getTopStudents().find((item) => item.name === student.name);
    if (topStudent) {
      events.unshift({
        id: 'top-students-competition',
        title: 'Top Students',
        featured: false,
        elements: [{ type: 'text', content: 'Outstanding Student Achievement' }],
        _isTopStudent: true,
        _topRole: { title: topStudent.role, icon: '★' }
      });
    }

    return events;
  },

  generateSlug(title) {
    return Utils.slugify(title);
  },

  generateId(title) {
    return this.generateSlug(title);
  },

  // --- Auth ---------------------------------------------------------------

  async signIn(password) {
    if (!client) throw new Error('Supabase is not configured.');
    const { data, error } = await client.auth.signInWithPassword({
      email: config.editorEmail,
      password
    });
    if (error) throw error;
    state.session = data.session;
    await this.reload({ admin: true });
    return data.session;
  },

  async signOut() {
    if (!client) return;
    await client.auth.signOut();
    state.session = null;
    state.profile = null;
  },

  async getSession() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    state.session = data?.session || null;
    return state.session;
  },

  async changePassword(password) {
    if (!client) throw new Error('Supabase is not configured.');
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
  },

  onAuthStateChange(callback) {
    if (!client) return null;
    return client.auth.onAuthStateChange(callback);
  },

  // --- Mutations ----------------------------------------------------------

  _requireClient() {
    if (!client) throw new Error('Supabase is not configured. Editing is disabled.');
  },

  async saveEvent(payload) {
    this._requireClient();
    const { data, error } = await client.rpc('save_event', { p_event: payload });
    if (error) throw error;
    await this.reload({ admin: true });
    return data;
  },

  async saveStudent(payload) {
    this._requireClient();
    const { data, error } = await client.rpc('save_student', { p_student: payload });
    if (error) throw error;
    await this.reload({ admin: true });
    return data;
  },

  async deleteEvent(idOrUuid, soft = true) {
    this._requireClient();
    const event = this.getEvent(idOrUuid);
    if (!event?.uuid) throw new Error('Event not found.');
    const { error } = await client.rpc('delete_event', { p_id: event.uuid, p_soft: soft });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async restoreEvent(idOrUuid) {
    this._requireClient();
    const event = this.getEvent(idOrUuid);
    if (!event?.uuid) throw new Error('Event not found.');
    const { error } = await client.rpc('restore_event', { p_id: event.uuid });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async deleteStudent(idOrUuid, soft = true) {
    this._requireClient();
    const student = this.getStudent(idOrUuid, { includeDeleted: true });
    if (!student?.uuid) throw new Error('Student not found.');
    const { error } = await client.rpc('delete_student', { p_id: student.uuid, p_soft: soft });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async restoreStudent(idOrUuid) {
    this._requireClient();
    const student = this.getStudent(idOrUuid, { includeDeleted: true });
    if (!student?.uuid) throw new Error('Student not found.');
    const { error } = await client.rpc('restore_student', { p_id: student.uuid });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async reorderEvents(ids) {
    this._requireClient();
    const uuids = ids
      .map((id) => this.getEvent(id)?.uuid)
      .filter(Boolean);
    const { error } = await client.rpc('reorder_events', { p_ids: uuids });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async saveCSE(headUuid, positions) {
    this._requireClient();
    const { error } = await client.rpc('save_cse', {
      p_head_student_id: headUuid || null,
      p_positions: positions
    });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async saveSettings(settings) {
    this._requireClient();
    const { error } = await client.rpc('save_settings', { p_settings: settings });
    if (error) throw error;
    await this.reload({ admin: true });
  },

  async duplicateEvent(idOrUuid) {
    this._requireClient();
    const event = this.getEvent(idOrUuid);
    if (!event?.uuid) throw new Error('Event not found.');
    const { data, error } = await client.rpc('duplicate_event', { p_id: event.uuid });
    if (error) throw error;
    await this.reload({ admin: true });
    return data;
  },

  async getAuditLog(limit = 100) {
    this._requireClient();
    const { data, error } = await client
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async uploadImage(file, folder = 'uploads') {
    this._requireClient();
    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${folder}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const bucket = config.mediaBucket || 'media';
    const { error } = await client.storage.from(bucket).upload(path, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false
    });
    if (error) throw error;
    const { data } = client.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  },

  async deleteImage(publicUrl) {
    this._requireClient();
    if (!publicUrl) return;
    const marker = `/object/public/${config.mediaBucket || 'media'}/`;
    const index = publicUrl.indexOf(marker);
    if (index === -1) return;
    const path = decodeURIComponent(publicUrl.slice(index + marker.length));
    const { error } = await client.storage.from(config.mediaBucket || 'media').remove([path]);
    if (error) throw error;
  },

  exportData() {
    const events = {
      events: this.getEvents({ includeDrafts: true, includeDeleted: true }).map((event) => ({
        id: event.id,
        title: event.title,
        category: event.category,
        date: event.date,
        featured: event.featured,
        elements: event.elements
      })),
      cseCouncil: this.getCSECouncil()
    };
    const students = {
      students: this.getStudents({ includeDeleted: true }).map((student) => ({
        id: student.id,
        name: student.name,
        role: student.role,
        quote: student.quote,
        image: student.image,
        star: student.star,
        type: student.type,
        class: student.class,
        achievements: student.achievements
      })),
      topStudents: this.getTopStudents()
    };
    return { events, students };
  }
};

window.DataStore = DataStore;
