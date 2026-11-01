(() => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    const CSE_STAGES = [
        ['secondary', 'Secondary'],
        ['preparatory', 'Preparatory'],
        ['primary', 'Primary']
    ];
    const CSE_ROLES = [
        ['president', 'President'],
        ['science', 'Science'],
        ['vicePresident', 'Vice President'],
        ['social', 'Social'],
        ['religiousCulture', 'Religious & Culture'],
        ['sports', 'Sports'],
        ['art', 'Art']
    ];
    const ELEMENT_LABELS = {
        text: 'Text',
        image: 'Image',
        slideshow: 'Slideshow',
        video: 'Video',
        quote: 'Quote',
        students: 'Students',
        organizers: 'Organizers'
    };

    const Admin = {
        pageSize: 8,
        eventsPage: 1,
        studentsPage: 1,
        eventFilters: { search: '', status: 'active', sort: 'order' },
        studentFilters: { search: '', type: 'active', class: '', sort: 'order' },
        editingEvent: null,
        editingStudent: null,
        elements: [],
        quills: new Map(),
        activeCropper: null,
        modalCleanup: null,
        currentView: 'events',
        audit: [],
        settingsDraft: null
    };

    const escape = (value) => Utils.escapeHtml(value);
    const attr = (value) => Utils.escapeAttr(value);

    function showLoginError(message) {
        const box = $('#loginError');
        if (!box) return;
        box.textContent = message || '';
        box.hidden = !message;
    }

    function showLogin() {
        $('#adminApp').hidden = true;
        $('#loginScreen').hidden = false;
        showLoginError('');
        setTimeout(() => $('#passwordInput')?.focus(), 50);
    }

    function showApp() {
        $('#loginScreen').hidden = true;
        $('#adminApp').hidden = false;
    }

    async function init() {
        bindStaticEvents();
        const configured = Boolean(
            window.MAGAZINE_CONFIG?.supabaseUrl &&
            window.MAGAZINE_CONFIG?.supabaseAnonKey &&
            window.DataStore?.client
        );
        if (!configured) {
            showLoginError('Supabase is not configured. Add your project URL and anon key to js/config.js, then reload.');
            $('#passwordInput').disabled = true;
            $('#loginButton').disabled = true;
            return;
        }

        try {
            const session = await DataStore.getSession();
            if (session) await enterApp();
            else showLogin();
        } catch (error) {
            showLogin();
            showLoginError(error.message);
        }

        DataStore.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') showLogin();
        });
    }

    async function enterApp() {
        showApp();
        const session = await DataStore.getSession();
        $('#userEmail').textContent = session?.user?.email || '';
        setListLoading($('#eventsList'));
        setListLoading($('#studentsList'));
        try {
            await DataStore.load({ admin: true, force: true });
            const profile = DataStore.getProfile?.();
            if (!profile || !['admin', 'editor'].includes(profile.role)) {
                await DataStore.signOut();
                showLogin();
                showLoginError('This account is not an editor. Run npm run setup:editor to grant access.');
                return;
            }
            $('#userRole').textContent = profile.role;
            renderEvents();
            renderStudents();
            renderCSE();
            renderSettings();
            showView('events');
        } catch (error) {
            Utils.toast(error.message, 'error');
            $('#eventsList').innerHTML = errorState(error.message);
            $('#studentsList').innerHTML = errorState(error.message);
        }
    }

    function bindStaticEvents() {
        $('#loginForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const password = $('#passwordInput').value;
            if (!password) {
                showLoginError('Enter the editor password.');
                return;
            }
            showLoginError('');
            const button = $('#loginButton');
            Utils.setBusy(button, true, 'Signing in…');
            try {
                await DataStore.signIn(password);
                $('#passwordInput').value = '';
                await enterApp();
            } catch (error) {
                showLoginError(error.message || 'Could not sign in.');
            } finally {
                Utils.setBusy(button, false);
            }
        });

        $('#logoutButton').addEventListener('click', async () => {
            await DataStore.signOut();
            showLogin();
        });

        $$('.side-link, .bottom-link').forEach((button) => {
            button.addEventListener('click', () => showView(button.dataset.view));
        });

        $('#newEventButton').addEventListener('click', () => openEventEditor(null));
        $('#newStudentButton').addEventListener('click', () => openStudentEditor(null));
        $('#backFromEvent').addEventListener('click', () => {
            Admin.editingEvent = null;
            showView('events');
        });
        $('#backFromStudent').addEventListener('click', () => {
            Admin.editingStudent = null;
            showView('students');
        });
        $('#saveEventButton').addEventListener('click', saveEvent);
        $('#saveStudentButton').addEventListener('click', saveStudent);
        $('#saveCseButton').addEventListener('click', saveCSE);
        $('#saveSettingsButton').addEventListener('click', saveSettings);
        $('#refreshAuditButton').addEventListener('click', loadAudit);

        $('#eventSearch').addEventListener('input', Utils.debounce((event) => {
            Admin.eventFilters.search = event.target.value.trim();
            Admin.eventsPage = 1;
            renderEvents();
        }, 180));
        $('#eventStatusFilter').addEventListener('change', (event) => {
            Admin.eventFilters.status = event.target.value;
            Admin.eventsPage = 1;
            renderEvents();
        });
        $('#eventSort').addEventListener('change', (event) => {
            Admin.eventFilters.sort = event.target.value;
            renderEvents();
        });

        $('#studentSearch').addEventListener('input', Utils.debounce((event) => {
            Admin.studentFilters.search = event.target.value.trim();
            Admin.studentsPage = 1;
            renderStudents();
        }, 180));
        $('#studentTypeFilter').addEventListener('change', (event) => {
            Admin.studentFilters.type = event.target.value;
            Admin.studentsPage = 1;
            renderStudents();
        });
        $('#studentClassFilter').addEventListener('change', (event) => {
            Admin.studentFilters.class = event.target.value;
            Admin.studentsPage = 1;
            renderStudents();
        });
        $('#studentSort').addEventListener('change', (event) => {
            Admin.studentFilters.sort = event.target.value;
            renderStudents();
        });

        $('#eventsList').addEventListener('click', handleEventListClick);
        $('#studentsList').addEventListener('click', handleStudentListClick);
        $('#auditList').addEventListener('click', handleAuditClick);
        $('#eventsPager').addEventListener('click', (event) => {
            const button = event.target.closest('[data-page]');
            if (!button) return;
            Admin.eventsPage = Number(button.dataset.page);
            renderEvents();
        });
        $('#studentsPager').addEventListener('click', (event) => {
            const button = event.target.closest('[data-page]');
            if (!button) return;
            Admin.studentsPage = Number(button.dataset.page);
            renderStudents();
        });

        document.addEventListener('click', (event) => {
            const addButton = event.target.closest('[data-add-element]');
            if (addButton) {
                addElement(addButton.dataset.addElement);
                return;
            }
            const uploadButton = event.target.closest('[data-upload-target]');
            if (uploadButton) {
                pickAndUpload(uploadButton.dataset.uploadTarget, uploadButton.dataset.uploadFolder || 'uploads', uploadButton.dataset.crop || '');
            }
        });

        $('#elementList').addEventListener('click', handleElementClick);
        $('#elementList').addEventListener('input', handleElementInput);
        $('#elementList').addEventListener('change', handleElementInput);

        ['eventTitle', 'eventSlug', 'eventDateLabel', 'eventDate', 'eventCoverImage', 'eventSeoTitle', 'eventSeoDescription', 'eventOgImage'].forEach((id) => {
            const field = document.getElementById(id);
            if (field) field.addEventListener('input', renderEventPreview);
        });
        $('#eventCoverImage').addEventListener('input', () => updateImagePreview('eventCoverImage', 'eventCoverPreview'));
        $('#studentImage').addEventListener('input', () => updateImagePreview('studentImage', 'studentImagePreview'));

        $('#downloadEventsButton').addEventListener('click', () => downloadJson('events.json', DataStore.exportData().events));
        $('#downloadStudentsButton').addEventListener('click', () => downloadJson('students.json', DataStore.exportData().students));
        $('#copyExportButton').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(JSON.stringify(DataStore.exportData(), null, 2));
                Utils.toast('JSON copied to clipboard.', 'success');
            } catch {
                Utils.toast('Could not copy JSON.', 'error');
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && $('#modalRoot').innerHTML) closeModal();
        });
    }

    function showView(view) {
        Admin.currentView = view;
        $$('.admin-view').forEach((section) => section.classList.remove('active'));
        const target = document.getElementById(`view-${view}`);
        if (target) target.classList.add('active');

        $$('.side-link, .bottom-link').forEach((button) => {
            const navView = button.dataset.view;
            const active =
                navView === view ||
                (view === 'event-editor' && navView === 'events') ||
                (view === 'student-editor' && navView === 'students');
            button.classList.toggle('active', active);
        });

        window.scrollTo({ top: 0, behavior: 'smooth' });

        if (view === 'audit') loadAudit();
        if (view === 'export') renderExport();
        if (view === 'settings') renderSettings();
        if (view === 'events') renderEvents();
        if (view === 'students') renderStudents();
    }

    function setListLoading(container, rows = 3) {
        if (!container) return;
        container.innerHTML = Array.from({ length: rows }, () => `
            <div class="admin-card">
                <div class="skeleton" style="width:100%;height:64px;"></div>
                <div>
                    <div class="skeleton skeleton-line" style="width:70%;margin-top:0;"></div>
                    <div class="skeleton skeleton-line short"></div>
                    <div class="skeleton skeleton-line" style="width:40%;"></div>
                </div>
            </div>
        `).join('');
    }

    function errorState(message) {
        return `<div class="error-state">${escape(message)}</div>`;
    }

    function emptyState(message) {
        return `<div class="empty-state">${escape(message)}</div>`;
    }

    function statusBadge(event) {
        if (event.deleted_at) return '<span class="badge badge-deleted">Deleted</span>';
        const status = event.status || 'draft';
        return `<span class="badge badge-${attr(status)}">${escape(status)}</span>`;
    }

    function eventCard(event) {
        const cover = DataStore.getEventPreviewImage(event) || 'assets/images/decorative.png';
        const elements = event.elements?.length || 0;
        return `
            <article class="admin-card">
                <img src="${attr(cover)}" alt="" class="admin-thumb" loading="lazy" onerror="this.src='assets/images/decorative.png'">
                <div>
                    <h3>${escape(event.title || 'Untitled event')}</h3>
                    <div class="meta">
                        ${statusBadge(event)}
                        <span class="badge">${escape(event.category || 'School')}</span>
                        <span>${escape(event.date || Utils.formatDate(event.event_date) || 'No date')}</span>
                        <span>${elements} element${elements === 1 ? '' : 's'}</span>
                        ${event.featured ? '<span class="badge badge-star">Featured</span>' : ''}
                    </div>
                    <div class="admin-actions">
                        ${event.deleted_at
                            ? `<button type="button" class="btn btn-secondary btn-small" data-action="restore-event" data-uuid="${attr(event.uuid)}">Restore</button>`
                            : `<button type="button" class="btn btn-primary btn-small" data-action="edit-event" data-uuid="${attr(event.uuid)}">Edit</button>
                               <button type="button" class="btn btn-secondary btn-small" data-action="duplicate-event" data-uuid="${attr(event.uuid)}">Duplicate</button>
                               <button type="button" class="btn btn-secondary btn-small" data-action="move-event-up" data-uuid="${attr(event.uuid)}" aria-label="Move up">↑</button>
                               <button type="button" class="btn btn-secondary btn-small" data-action="move-event-down" data-uuid="${attr(event.uuid)}" aria-label="Move down">↓</button>
                               <button type="button" class="btn btn-danger btn-small" data-action="delete-event" data-uuid="${attr(event.uuid)}">Delete</button>`}
                    </div>
                </div>
            </article>
        `;
    }

    function filteredEvents() {
        let events = DataStore.getEvents({ includeDeleted: true, includeDrafts: true });
        const { search, status, sort } = Admin.eventFilters;

        if (status === 'active') events = events.filter((event) => !event.deleted_at);
        if (status === 'published') events = events.filter((event) => !event.deleted_at && event.status === 'published');
        if (status === 'draft') events = events.filter((event) => !event.deleted_at && event.status === 'draft');
        if (status === 'deleted') events = events.filter((event) => event.deleted_at);

        if (search) {
            const query = search.toLowerCase();
            events = events.filter((event) =>
                [event.title, event.category, event.date, event.slug].some((value) =>
                    String(value || '').toLowerCase().includes(query)
                )
            );
        }

        if (sort === 'newest') {
            events.sort((a, b) => String(b.event_date || b.published_at || '').localeCompare(String(a.event_date || a.published_at || '')));
        } else if (sort === 'title') {
            events.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        } else if (sort === 'date') {
            events.sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
        } else {
            events.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        }
        return events;
    }

    function renderEvents() {
        const all = DataStore.getEvents({ includeDeleted: true, includeDrafts: true });
        const active = all.filter((event) => !event.deleted_at);
        $('#eventsSummary').textContent = `${active.length} active · ${active.filter((event) => event.status === 'published').length} published · ${active.filter((event) => event.status === 'draft').length} drafts`;

        const events = filteredEvents();
        const pages = Math.max(1, Math.ceil(events.length / Admin.pageSize));
        Admin.eventsPage = Math.min(Admin.eventsPage, pages);
        const start = (Admin.eventsPage - 1) * Admin.pageSize;
        const visible = events.slice(start, start + Admin.pageSize);

        $('#eventsList').innerHTML = visible.length
            ? visible.map(eventCard).join('')
            : emptyState(Admin.eventFilters.search ? 'No events match your search.' : 'No events yet. Create your first one.');

        renderPager($('#eventsPager'), Admin.eventsPage, pages, 'events');
    }

    function renderPager(container, page, pages, kind) {
        if (!container) return;
        if (pages <= 1) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = `
            <button type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
            <span>Page ${page} of ${pages}</span>
            <button type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next →</button>
        `;
        container.dataset.kind = kind;
    }

    async function handleEventListClick(event) {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const uuid = button.dataset.uuid;

        if (action === 'edit-event') {
            const item = DataStore.getEvent(uuid);
            if (item) openEventEditor(item);
            return;
        }

        if (action === 'duplicate-event') {
            Utils.setBusy(button, true, 'Copying…');
            try {
                await DataStore.duplicateEvent(uuid);
                renderEvents();
                Utils.toast('Event duplicated as a draft.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            } finally {
                Utils.setBusy(button, false);
            }
            return;
        }

        if (action === 'delete-event') {
            const item = DataStore.getEvent(uuid);
            const confirmed = await confirmDialog('Delete event?', `“${item?.title || 'This event'}” will be hidden from the site. You can restore it from the Deleted filter.`, 'Delete');
            if (!confirmed) return;
            try {
                await DataStore.deleteEvent(uuid, true);
                renderEvents();
                Utils.toast('Event moved to deleted.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
            return;
        }

        if (action === 'restore-event') {
            try {
                await DataStore.restoreEvent(uuid);
                renderEvents();
                Utils.toast('Event restored.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
            return;
        }

        if (action === 'move-event-up' || action === 'move-event-down') {
            const ordered = DataStore.getEvents({ includeDeleted: false, includeDrafts: true })
                .slice()
                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
            const index = ordered.findIndex((item) => item.uuid === uuid);
            const swapWith = action === 'move-event-up' ? index - 1 : index + 1;
            if (index === -1 || swapWith < 0 || swapWith >= ordered.length) return;
            [ordered[index], ordered[swapWith]] = [ordered[swapWith], ordered[index]];
            try {
                await DataStore.reorderEvents(ordered.map((item) => item.id));
                renderEvents();
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
        }
    }

    function elementToDraft(element) {
        if (element.type === 'text') return { type: 'text', content: element.content || '' };
        if (element.type === 'image') return { type: 'image', image: element.image || '', align: element.align || 'full', caption: element.caption || '' };
        if (element.type === 'slideshow') return { type: 'slideshow', images: [...(element.images || [])], caption: element.caption || '' };
        if (element.type === 'video') return { type: 'video', video: element.video || '' };
        if (element.type === 'quote') return { type: 'quote', quote: element.quote || '', author: element.author || '' };
        if (element.type === 'students' || element.type === 'organizers') {
            const people = element.type === 'students' ? element.students : element.organizers;
            return {
                type: element.type,
                people: (people || []).map((person) => ({
                    student_id: person.student_id || '',
                    name: person.name || '',
                    role: person.role || '',
                    achievement: person.achievement || ''
                }))
            };
        }
        return { type: element.type };
    }

    function openEventEditor(item) {
        Admin.editingEvent = item;
        Admin.elements = item ? (item.elements || []).map(elementToDraft) : [];
        $('#eventEditorTitle').textContent = item ? 'Edit Event' : 'New Event';
        $('#eventUuid').value = item?.uuid || '';
        $('#eventTitle').value = item?.title || '';
        $('#eventSlug').value = item?.slug || '';
        $('#eventCategory').value = item?.category || 'Academic';
        $('#eventDateLabel').value = item?.date || '';
        $('#eventDate').value = item?.event_date || '';
        $('#eventStatus').value = item?.status || 'draft';
        $('#eventFeatured').checked = Boolean(item?.featured);
        $('#eventSortOrder').value = item?.sort_order ?? 0;
        $('#eventCoverImage').value = item?.cover_image_url || '';
        $('#eventSeoTitle').value = item?.seo_title || '';
        $('#eventSeoDescription').value = item?.seo_description || '';
        $('#eventOgImage').value = item?.og_image_url || '';
        updateImagePreview('eventCoverImage', 'eventCoverPreview');
        renderElements();
        renderEventPreview();
        showView('event-editor');
    }

    function elementBody(element, index) {
        if (element.type === 'text') {
            if (!window.Quill) {
                return `<textarea class="input" rows="6" data-el-index="${index}" data-el-field="content" placeholder="Write the article text…">${escape(element.content || '')}</textarea>`;
            }
            return `<div class="quill-wrap"><div class="quill-editor" data-quill-index="${index}"></div></div>`;
        }
        if (element.type === 'image') {
            return `
                <div class="image-field">
                    <input class="input" data-el-index="${index}" data-el-field="image" value="${attr(element.image || '')}" placeholder="Image URL">
                    <button type="button" class="btn btn-secondary btn-small" data-action="upload-element-image" data-index="${index}">Upload</button>
                </div>
                ${element.image ? `<img class="image-preview wide" src="${attr(element.image)}" alt="">` : ''}
                <div class="field-grid" style="margin-top:8px;">
                    <label class="field">
                        <span>Alignment</span>
                        <select class="input" data-el-index="${index}" data-el-field="align">
                            <option value="full" ${element.align === 'full' ? 'selected' : ''}>Full width</option>
                            <option value="left" ${element.align === 'left' ? 'selected' : ''}>Left</option>
                            <option value="right" ${element.align === 'right' ? 'selected' : ''}>Right</option>
                            <option value="center" ${element.align === 'center' ? 'selected' : ''}>Center</option>
                        </select>
                    </label>
                    <label class="field">
                        <span>Caption</span>
                        <input class="input" data-el-index="${index}" data-el-field="caption" value="${attr(element.caption || '')}">
                    </label>
                </div>
            `;
        }
        if (element.type === 'slideshow') {
            const images = element.images || [];
            return `
                <div class="slide-list">
                    ${images.map((image, slideIndex) => `
                        <div class="slide-row">
                            <div class="image-field">
                                <input class="input" data-el-index="${index}" data-slide-index="${slideIndex}" data-slide-url value="${attr(image)}" placeholder="Image URL">
                                <img src="${attr(image)}" alt="">
                            </div>
                            <button type="button" class="icon-btn danger" data-action="remove-slide" data-index="${index}" data-slide-index="${slideIndex}" aria-label="Remove slide">×</button>
                        </div>
                    `).join('')}
                </div>
                <div class="image-field">
                    <input class="input" data-new-slide placeholder="Paste an image URL">
                    <button type="button" class="btn btn-secondary btn-small" data-action="add-slide-url" data-index="${index}">Add URL</button>
                </div>
                <button type="button" class="chip-btn" data-action="upload-slide" data-index="${index}" style="margin-top:8px;">+ Upload slide</button>
                <label class="field" style="margin-top:8px;">
                    <span>Caption</span>
                    <input class="input" data-el-index="${index}" data-el-field="caption" value="${attr(element.caption || '')}">
                </label>
            `;
        }
        if (element.type === 'video') {
            const embed = Utils.youtubeEmbedUrl(element.video);
            return `
                <label class="field">
                    <span>YouTube URL or video ID</span>
                    <input class="input" data-el-index="${index}" data-el-field="video" value="${attr(element.video || '')}" placeholder="https://youtu.be/…">
                </label>
                ${embed ? `<iframe src="${attr(embed)}" title="Video preview" loading="lazy" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:8px;"></iframe>` : ''}
            `;
        }
        if (element.type === 'quote') {
            return `
                <label class="field">
                    <span>Quote</span>
                    <textarea class="input" rows="3" data-el-index="${index}" data-el-field="quote">${escape(element.quote || '')}</textarea>
                </label>
                <label class="field">
                    <span>Author</span>
                    <input class="input" data-el-index="${index}" data-el-field="author" value="${attr(element.author || '')}">
                </label>
            `;
        }
        if (element.type === 'students' || element.type === 'organizers') {
            const people = element.people || [];
            return `
                <div class="person-list">
                    ${people.map((person, personIndex) => `
                        <div class="person-row">
                            <div class="person-top">
                                <span class="person-name">${escape(person.name || 'Unnamed')}</span>
                                <button type="button" class="icon-btn danger" data-action="remove-person" data-index="${index}" data-person-index="${personIndex}" aria-label="Remove person">×</button>
                            </div>
                            <div class="person-fields">
                                <input class="input" data-el-index="${index}" data-person-index="${personIndex}" data-person-field="name" value="${attr(person.name || '')}" placeholder="Name">
                                <input class="input" data-el-index="${index}" data-person-index="${personIndex}" data-person-field="role" value="${attr(person.role || '')}" placeholder="Role">
                                <input class="input" data-el-index="${index}" data-person-index="${personIndex}" data-person-field="achievement" value="${attr(person.achievement || '')}" placeholder="Achievement / class">
                            </div>
                        </div>
                    `).join('')}
                </div>
                <button type="button" class="chip-btn" data-action="add-person" data-index="${index}" style="margin-top:8px;">+ Add student</button>
            `;
        }
        return '';
    }

    function renderElements() {
        Admin.quills.clear();
        const list = $('#elementList');
        if (!Admin.elements.length) {
            list.innerHTML = emptyState('No elements yet. Add text, images, a video, or linked students.');
            return;
        }

        list.innerHTML = Admin.elements.map((element, index) => `
            <div class="element-card" data-element-index="${index}">
                <div class="element-head">
                    <span class="element-type">${escape(ELEMENT_LABELS[element.type] || element.type)}</span>
                    <div class="element-tools">
                        <button type="button" class="icon-btn" data-action="move-element-up" data-index="${index}" aria-label="Move element up">↑</button>
                        <button type="button" class="icon-btn" data-action="move-element-down" data-index="${index}" aria-label="Move element down">↓</button>
                        <button type="button" class="icon-btn danger" data-action="remove-element" data-index="${index}" aria-label="Remove element">×</button>
                    </div>
                </div>
                ${elementBody(element, index)}
            </div>
        `).join('');

        if (window.Quill) {
            Admin.elements.forEach((element, index) => {
                if (element.type !== 'text') return;
                const container = list.querySelector(`[data-quill-index="${index}"]`);
                if (!container) return;
                const quill = new Quill(container, {
                    theme: 'snow',
                    modules: {
                        toolbar: [
                            [{ header: [2, 3, false] }],
                            ['bold', 'italic', 'underline'],
                            [{ list: 'ordered' }, { list: 'bullet' }],
                            ['blockquote', 'link'],
                            ['clean']
                        ]
                    }
                });
                if (element.content) quill.clipboard.dangerouslyPasteHTML(element.content);
                quill.on('text-change', () => {
                    element.content = quill.root.innerHTML;
                    renderEventPreview();
                });
                Admin.quills.set(index, quill);
            });
        }
    }

    function addElement(type) {
        const base = { type };
        if (type === 'text') base.content = '';
        if (type === 'image') Object.assign(base, { image: '', align: 'full', caption: '' });
        if (type === 'slideshow') Object.assign(base, { images: [], caption: '' });
        if (type === 'video') base.video = '';
        if (type === 'quote') Object.assign(base, { quote: '', author: '' });
        if (type === 'students' || type === 'organizers') base.people = [];
        Admin.elements.push(base);
        renderElements();
        renderEventPreview();
    }

    function handleElementInput(event) {
        const target = event.target;
        const index = Number(target.dataset.elIndex);
        if (Number.isNaN(index) || !Admin.elements[index]) return;
        const element = Admin.elements[index];

        if (target.dataset.personField) {
            const personIndex = Number(target.dataset.personIndex);
            if (element.people?.[personIndex]) element.people[personIndex][target.dataset.personField] = target.value;
        } else if (target.dataset.slideUrl !== undefined) {
            const slideIndex = Number(target.dataset.slideIndex);
            if (element.images?.[slideIndex] !== undefined) element.images[slideIndex] = target.value;
        } else if (target.dataset.elField) {
            element[target.dataset.elField] = target.value;
        }
        renderEventPreview();
    }

    async function handleElementClick(event) {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const index = Number(button.dataset.index);
        if (Number.isNaN(index) || !Admin.elements[index]) return;
        const element = Admin.elements[index];

        if (action === 'remove-element') {
            Admin.elements.splice(index, 1);
            renderElements();
            renderEventPreview();
        } else if (action === 'move-element-up' || action === 'move-element-down') {
            const swapWith = action === 'move-element-up' ? index - 1 : index + 1;
            if (swapWith < 0 || swapWith >= Admin.elements.length) return;
            [Admin.elements[index], Admin.elements[swapWith]] = [Admin.elements[swapWith], Admin.elements[index]];
            renderElements();
            renderEventPreview();
        } else if (action === 'remove-person') {
            const personIndex = Number(button.dataset.personIndex);
            element.people.splice(personIndex, 1);
            renderElements();
            renderEventPreview();
        } else if (action === 'remove-slide') {
            const slideIndex = Number(button.dataset.slideIndex);
            element.images.splice(slideIndex, 1);
            renderElements();
            renderEventPreview();
        } else if (action === 'add-person') {
            openStudentPicker(index);
        } else if (action === 'add-slide-url') {
            const input = button.closest('.element-card').querySelector('[data-new-slide]');
            const value = input?.value.trim();
            if (!value) return;
            element.images.push(value);
            renderElements();
            renderEventPreview();
        } else if (action === 'upload-slide') {
            pickAndUpload(null, 'events', 'wide', (url) => {
                element.images.push(url);
                renderElements();
                renderEventPreview();
            });
        } else if (action === 'upload-element-image') {
            pickAndUpload(null, 'events', 'wide', (url) => {
                element.image = url;
                renderElements();
                renderEventPreview();
            });
        }
    }

    function openStudentPicker(elementIndex) {
        const element = Admin.elements[elementIndex];
        if (!element) return;
        const existing = new Set((element.people || []).map((person) => person.student_id).filter(Boolean));
        const students = DataStore.getStudents().filter((student) => !existing.has(student.uuid));

        const renderResults = (query = '') => {
            const q = query.toLowerCase();
            const matches = students.filter((student) =>
                [student.name, student.role, student.class].some((value) =>
                    String(value || '').toLowerCase().includes(q)
                )
            ).slice(0, 40);
            return matches.length
                ? matches.map((student) => `
                    <button type="button" class="search-result" data-pick-student="${attr(student.uuid)}">
                        ${student.image ? `<img src="${attr(student.image)}" alt="">` : ''}
                        <span>${escape(student.name)}${student.class ? ` · ${escape(student.class)}` : ''}</span>
                    </button>
                `).join('')
                : '<p class="muted" style="padding:12px;">No students found.</p>';
        };

        const modal = openModal(`
            <h2>Add a student</h2>
            <div class="search-select">
                <input type="search" class="input" id="pickerSearch" placeholder="Search by name or class…">
                <div class="search-results" id="pickerResults">${renderResults()}</div>
                <div class="field" style="margin-top:8px;">
                    <span>Or add a custom name</span>
                    <div class="image-field">
                        <input type="text" class="input" id="customPersonName" placeholder="Name">
                        <button type="button" class="btn btn-secondary btn-small" id="addCustomPerson">Add</button>
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-close-modal>Done</button>
            </div>
        `);

        const results = modal.querySelector('#pickerResults');
        modal.querySelector('#pickerSearch').addEventListener('input', (event) => {
            results.innerHTML = renderResults(event.target.value);
        });
        results.addEventListener('click', (event) => {
            const button = event.target.closest('[data-pick-student]');
            if (!button) return;
            const student = DataStore.getStudent(button.dataset.pickStudent);
            if (!student) return;
            element.people.push({
                student_id: student.uuid || '',
                name: student.name,
                role: '',
                achievement: student.class || ''
            });
            closeModal();
            renderElements();
            renderEventPreview();
        });
        modal.querySelector('#addCustomPerson').addEventListener('click', () => {
            const name = modal.querySelector('#customPersonName').value.trim();
            if (!name) return;
            element.people.push({ student_id: '', name, role: '', achievement: '' });
            closeModal();
            renderElements();
            renderEventPreview();
        });
        modal.querySelector('[data-close-modal]').addEventListener('click', closeModal);
    }

    function previewElement(element) {
        if (element.type === 'text') return `<div class="rich-text">${Utils.sanitize(element.content || '')}</div>`;
        if (element.type === 'image' && element.image) {
            return `<figure><img src="${attr(element.image)}" alt="${attr(element.caption || '')}"><figcaption>${escape(element.caption || '')}</figcaption></figure>`;
        }
        if (element.type === 'slideshow' && element.images?.length) {
            return `<figure><img src="${attr(element.images[0])}" alt=""><figcaption>${escape(element.caption || '')} (${element.images.length} photos)</figcaption></figure>`;
        }
        if (element.type === 'video') {
            const embed = Utils.youtubeEmbedUrl(element.video);
            return embed ? `<iframe src="${attr(embed)}" title="Video" loading="lazy" allowfullscreen></iframe>` : '';
        }
        if (element.type === 'quote') {
            return `<blockquote><p>${escape(element.quote || '')}</p><cite>${escape(element.author || '')}</cite></blockquote>`;
        }
        if (element.type === 'students' || element.type === 'organizers') {
            return `<div class="student-links">${(element.people || []).map((person) =>
                `<span class="student-chip">${escape(person.name || '')}${person.role ? ` · ${escape(person.role)}` : ''}</span>`
            ).join('')}</div>`;
        }
        return '';
    }

    function renderEventPreview() {
        const preview = $('#eventPreview');
        if (!preview) return;
        const title = $('#eventTitle').value.trim() || 'Untitled event';
        const date = $('#eventDateLabel').value.trim() || Utils.formatDate($('#eventDate').value);
        const cover = $('#eventCoverImage').value.trim();
        const slug = $('#eventSlug').value.trim() || Utils.slugify(title);

        preview.innerHTML = `
            ${cover ? `<img class="preview-cover" src="${attr(cover)}" alt="">` : ''}
            <h1>${escape(title)}</h1>
            <p class="muted">${escape($('#eventCategory').value)}${date ? ` · ${escape(date)}` : ''}</p>
            ${Admin.elements.map(previewElement).join('')}
        `;

        const seoTitle = $('#eventSeoTitle').value.trim() || title;
        const firstText = Admin.elements.find((element) => element.type === 'text' && element.content);
        const seoDescription = $('#eventSeoDescription').value.trim() ||
            Utils.truncate(String(firstText?.content || '').replace(/<[^>]*>/g, ' '), 155) ||
            'Read this story on The Rising Times.';
        const seoImage = $('#eventOgImage').value.trim() || cover || 'assets/images/logo1.png';

        $('#eventSeoPreview').innerHTML = `
            <div class="seo-title">${escape(seoTitle)}</div>
            <div class="seo-url">therisingtimes.vercel.app/article.html?id=${attr(slug)}</div>
            <div class="seo-desc">${escape(seoDescription)}</div>
            <img src="${attr(seoImage)}" alt="" style="width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;margin-top:8px;">
        `;
    }

    function eventPayload() {
        const title = $('#eventTitle').value.trim();
        if (!title) throw new Error('A title is required.');
        return {
            id: $('#eventUuid').value || '',
            title,
            slug: $('#eventSlug').value.trim() || Utils.slugify(title),
            category: $('#eventCategory').value,
            date_label: $('#eventDateLabel').value.trim(),
            event_date: $('#eventDate').value || '',
            featured: $('#eventFeatured').checked,
            status: $('#eventStatus').value,
            sort_order: Number($('#eventSortOrder').value) || 0,
            cover_image_url: $('#eventCoverImage').value.trim(),
            seo_title: $('#eventSeoTitle').value.trim(),
            seo_description: $('#eventSeoDescription').value.trim(),
            og_image_url: $('#eventOgImage').value.trim(),
            elements: Admin.elements.map((element) => {
                const data = {};
                if (element.type === 'text') data.content = Utils.sanitize(element.content || '');
                if (element.type === 'image') Object.assign(data, {
                    image: element.image || '',
                    align: element.align || 'full',
                    caption: element.caption || ''
                });
                if (element.type === 'slideshow') Object.assign(data, {
                    images: (element.images || []).filter(Boolean),
                    caption: element.caption || ''
                });
                if (element.type === 'video') data.video = Utils.youtubeId(element.video) || element.video || '';
                if (element.type === 'quote') Object.assign(data, {
                    quote: element.quote || '',
                    author: element.author || ''
                });
                return {
                    type: element.type,
                    data,
                    people: (element.people || []).map((person) => ({
                        student_id: person.student_id || '',
                        name: person.name || '',
                        role: person.role || '',
                        achievement: person.achievement || ''
                    }))
                };
            })
        };
    }

    async function saveEvent() {
        const button = $('#saveEventButton');
        Utils.setBusy(button, true, 'Saving…');
        try {
            const payload = eventPayload();
            await DataStore.saveEvent(payload);
            Utils.toast('Event saved.', 'success');
            Admin.editingEvent = null;
            showView('events');
        } catch (error) {
            Utils.toast(error.message, 'error');
        } finally {
            Utils.setBusy(button, false);
        }
    }

    function studentCard(student) {
        const image = student.image || 'assets/images/decorative.png';
        return `
            <article class="admin-card">
                <img src="${attr(image)}" alt="" class="admin-thumb avatar" loading="lazy" onerror="this.src='assets/images/decorative.png'">
                <div>
                    <h3>${escape(student.name || 'Unnamed student')}</h3>
                    <div class="meta">
                        ${student.deleted_at ? '<span class="badge badge-deleted">Deleted</span>' : ''}
                        <span class="badge">${escape(student.type === 'teacher' ? 'Teacher' : (student.class || 'Student'))}</span>
                        ${student.role ? `<span>${escape(student.role)}</span>` : ''}
                        ${student.star ? '<span class="badge badge-star">Star</span>' : ''}
                        ${student.is_top ? `<span class="badge badge-top">Top${student.top_role ? ` · ${escape(student.top_role)}` : ''}</span>` : ''}
                    </div>
                    <div class="admin-actions">
                        ${student.deleted_at
                            ? `<button type="button" class="btn btn-secondary btn-small" data-action="restore-student" data-uuid="${attr(student.uuid)}">Restore</button>`
                            : `<button type="button" class="btn btn-primary btn-small" data-action="edit-student" data-uuid="${attr(student.uuid)}">Edit</button>
                               <button type="button" class="btn btn-secondary btn-small" data-action="toggle-star" data-uuid="${attr(student.uuid)}">${student.star ? 'Unstar' : 'Star'}</button>
                               <button type="button" class="btn btn-secondary btn-small" data-action="toggle-top" data-uuid="${attr(student.uuid)}">${student.is_top ? 'Remove top' : 'Top'}</button>
                               <button type="button" class="btn btn-danger btn-small" data-action="delete-student" data-uuid="${attr(student.uuid)}">Delete</button>`}
                    </div>
                </div>
            </article>
        `;
    }

    function filteredStudents() {
        let students = DataStore.getStudents({ includeDeleted: true });
        const { search, type, class: classLevel, sort } = Admin.studentFilters;

        if (type === 'active') students = students.filter((student) => !student.deleted_at);
        if (type === 'student') students = students.filter((student) => !student.deleted_at && student.type === 'student');
        if (type === 'teacher') students = students.filter((student) => !student.deleted_at && student.type === 'teacher');
        if (type === 'star') students = students.filter((student) => !student.deleted_at && student.star);
        if (type === 'top') students = students.filter((student) => !student.deleted_at && student.is_top);
        if (type === 'deleted') students = students.filter((student) => student.deleted_at);
        if (classLevel) students = students.filter((student) => student.class === classLevel);

        if (search) {
            const query = search.toLowerCase();
            students = students.filter((student) =>
                [student.name, student.role, student.class, student.top_role].some((value) =>
                    String(value || '').toLowerCase().includes(query)
                )
            );
        }

        if (sort === 'name') students.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        else if (sort === 'class') students.sort((a, b) => String(a.class || '').localeCompare(String(b.class || '')) || String(a.name || '').localeCompare(String(b.name || '')));
        else students.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name || '').localeCompare(String(b.name || '')));

        return students;
    }

    function renderStudents() {
        const all = DataStore.getStudents({ includeDeleted: true });
        const active = all.filter((student) => !student.deleted_at);
        $('#studentsSummary').textContent = `${active.length} active · ${active.filter((student) => student.type === 'teacher').length} teachers · ${active.filter((student) => student.star).length} stars · ${active.filter((student) => student.is_top).length} top`;

        const students = filteredStudents();
        const pages = Math.max(1, Math.ceil(students.length / Admin.pageSize));
        Admin.studentsPage = Math.min(Admin.studentsPage, pages);
        const start = (Admin.studentsPage - 1) * Admin.pageSize;
        const visible = students.slice(start, start + Admin.pageSize);

        $('#studentsList').innerHTML = visible.length
            ? visible.map(studentCard).join('')
            : emptyState(Admin.studentFilters.search ? 'No students match your search.' : 'No students yet. Add your first one.');

        renderPager($('#studentsPager'), Admin.studentsPage, pages, 'students');
    }

    function studentPayload(student, overrides = {}) {
        return {
            id: student.uuid || '',
            name: student.name || '',
            slug: student.slug || '',
            role: student.role || '',
            quote: student.quote || '',
            image_url: student.image || '',
            star: Boolean(student.star),
            type: student.type || 'student',
            class_level: student.type === 'teacher' ? '' : (student.class_level || ''),
            achievements: student.achievements || [],
            is_top: Boolean(student.is_top),
            top_role: student.top_role || '',
            sort_order: student.sort_order ?? 0,
            ...overrides
        };
    }

    function openStudentEditor(student) {
        Admin.editingStudent = student;
        $('#studentEditorTitle').textContent = student ? 'Edit Student' : 'New Student';
        $('#studentUuid').value = student?.uuid || '';
        $('#studentName').value = student?.name || '';
        $('#studentSlug').value = student?.slug || '';
        $('#studentRole').value = student?.role || '';
        $('#studentType').value = student?.type || 'student';
        $('#studentClass').value = student?.class_level || '';
        $('#studentSortOrder').value = student?.sort_order ?? 0;
        $('#studentStar').checked = Boolean(student?.star);
        $('#studentTop').checked = Boolean(student?.is_top);
        $('#studentTopRole').value = student?.top_role || '';
        $('#studentQuote').value = student?.quote || '';
        $('#studentAchievements').value = (student?.achievements || []).join('\n');
        $('#studentImage').value = student?.image || '';
        updateImagePreview('studentImage', 'studentImagePreview');
        showView('student-editor');
    }

    async function handleStudentListClick(event) {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const uuid = button.dataset.uuid;
        const student = DataStore.getStudent(uuid, { includeDeleted: true });
        if (!student) return;

        if (action === 'edit-student') {
            openStudentEditor(student);
            return;
        }

        if (action === 'delete-student') {
            const confirmed = await confirmDialog('Delete student?', `“${student.name}” will be hidden from the site. You can restore them from the Deleted filter.`, 'Delete');
            if (!confirmed) return;
            try {
                await DataStore.deleteStudent(uuid, true);
                renderStudents();
                Utils.toast('Student moved to deleted.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
            return;
        }

        if (action === 'restore-student') {
            try {
                await DataStore.restoreStudent(uuid);
                renderStudents();
                Utils.toast('Student restored.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
            return;
        }

        if (action === 'toggle-star' || action === 'toggle-top') {
            const overrides = action === 'toggle-star'
                ? { star: !student.star }
                : { is_top: !student.is_top };
            Utils.setBusy(button, true, 'Saving…');
            try {
                await DataStore.saveStudent(studentPayload(student, overrides));
                renderStudents();
                Utils.toast('Student updated.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            } finally {
                Utils.setBusy(button, false);
            }
        }
    }

    async function saveStudent() {
        const name = $('#studentName').value.trim();
        if (!name) {
            Utils.toast('A name is required.', 'error');
            return;
        }
        const type = $('#studentType').value;
        const payload = {
            id: $('#studentUuid').value || '',
            name,
            slug: $('#studentSlug').value.trim() || Utils.slugify(name),
            role: $('#studentRole').value.trim(),
            quote: $('#studentQuote').value.trim(),
            image_url: $('#studentImage').value.trim(),
            star: $('#studentStar').checked,
            type,
            class_level: type === 'teacher' ? '' : $('#studentClass').value,
            achievements: $('#studentAchievements').value
                .split(/[\n,]+/)
                .map((value) => value.trim())
                .filter(Boolean),
            is_top: $('#studentTop').checked,
            top_role: $('#studentTopRole').value.trim(),
            sort_order: Number($('#studentSortOrder').value) || 0
        };

        const button = $('#saveStudentButton');
        Utils.setBusy(button, true, 'Saving…');
        try {
            await DataStore.saveStudent(payload);
            Utils.toast('Student saved.', 'success');
            Admin.editingStudent = null;
            showView('students');
        } catch (error) {
            Utils.toast(error.message, 'error');
        } finally {
            Utils.setBusy(button, false);
        }
    }

    function studentOptions(selectedUuid = '') {
        const students = DataStore.getStudents().slice().sort((a, b) => a.name.localeCompare(b.name));
        return students.map((student) => `
            <option value="${attr(student.uuid || '')}" ${student.uuid === selectedUuid ? 'selected' : ''}>
                ${escape(student.name)}${student.class ? ` · ${escape(student.class)}` : ''}
            </option>
        `).join('');
    }

    function renderCSE() {
        const council = DataStore.getCSECouncil();
        const head = $('#cseHead');
        head.innerHTML = `<option value="">Miss Somia (no linked profile)</option>${studentOptions(council.headId || '')}`;
        if (!council.headId && council.head && council.head !== 'Miss Somia') {
            head.insertAdjacentHTML('afterbegin', `<option value="" selected>${escape(council.head)} (no linked profile)</option>`);
        }

        $('#cseStages').innerHTML = CSE_STAGES.map(([stageKey, stageLabel]) => `
            <div class="cse-stage">
                <div class="panel">
                    <h2>${escape(stageLabel)}</h2>
                    <div class="cse-stage-grid">
                        ${CSE_ROLES.map(([roleKey, roleLabel]) => {
                            const selected = DataStore.getStudent(council.stages[stageKey]?.[roleKey] || '');
                            return `
                                <label class="field">
                                    <span>${escape(roleLabel)}</span>
                                    <select class="input" data-cse-stage="${stageKey}" data-cse-role="${roleKey}">
                                        <option value="">Vacant</option>
                                        ${studentOptions(selected?.uuid || '')}
                                    </select>
                                </label>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        `).join('');
    }

    async function saveCSE() {
        const positions = [];
        $$('[data-cse-stage]').forEach((select) => {
            positions.push({
                stage: select.dataset.cseStage,
                role: select.dataset.cseRole,
                student_id: select.value || ''
            });
        });
        const button = $('#saveCseButton');
        Utils.setBusy(button, true, 'Saving…');
        try {
            await DataStore.saveCSE($('#cseHead').value || null, positions);
            renderCSE();
            Utils.toast('CSE council saved.', 'success');
        } catch (error) {
            Utils.toast(error.message, 'error');
        } finally {
            Utils.setBusy(button, false);
        }
    }

    function renderSettings() {
        const site = DataStore.getSettings('site');
        const hero = DataStore.getSettings('hero');
        const about = DataStore.getSettings('about');
        const school = DataStore.getSettings('school');
        const social = DataStore.getSettings('social');
        const videos = DataStore.getSettings('videos');
        const footer = DataStore.getSettings('footer');
        const seo = DataStore.getSettings('seo');
        const team = DataStore.getSettings('team');
        const priority = DataStore.getSettings('student_priority');

        $('#settingsForm').innerHTML = `
            <div class="panel">
                <h2>Identity</h2>
                <label class="field"><span>Site name</span><input class="input" id="settingSiteName" value="${attr(site.name)}"></label>
                <label class="field"><span>School</span><input class="input" id="settingSchool" value="${attr(site.school)}"></label>
                <label class="field"><span>School system</span><input class="input" id="settingSystem" value="${attr(site.system)}"></label>
            </div>
            <div class="panel">
                <h2>Hero</h2>
                <label class="field"><span>Title</span><input class="input" id="settingHeroTitle" value="${attr(hero.title)}"></label>
                <label class="field"><span>Subtitle</span><textarea class="input" rows="3" id="settingHeroSubtitle">${escape(hero.subtitle)}</textarea></label>
                <label class="field"><span>Button label</span><input class="input" id="settingHeroButton" value="${attr(hero.readMore)}"></label>
            </div>
            <div class="panel">
                <h2>About</h2>
                <label class="field"><span>About text</span><textarea class="input" rows="5" id="settingAboutText">${escape(about.text)}</textarea></label>
                <label class="field"><span>Button label</span><input class="input" id="settingAboutCta" value="${attr(about.cta)}"></label>
            </div>
            <div class="panel">
                <h2>School highlights</h2>
                <label class="field"><span>One item per line</span><textarea class="input" rows="5" id="settingSchoolItems">${escape((school.items || []).join('\n'))}</textarea></label>
            </div>
            <div class="panel">
                <h2>Social</h2>
                <label class="field"><span>Instagram URL</span><input class="input" id="settingInstagram" value="${attr(social.instagram)}"></label>
                <label class="field"><span>Facebook URL</span><input class="input" id="settingFacebook" value="${attr(social.facebook)}"></label>
            </div>
            <div class="panel">
                <h2>Videos</h2>
                <label class="field"><span>Main video URL</span><input class="input" id="settingVideoMain" value="${attr(videos.main)}"></label>
                <label class="field"><span>Secondary video URL</span><input class="input" id="settingVideoSecondary" value="${attr(videos.secondary)}"></label>
            </div>
            <div class="panel">
                <h2>Footer</h2>
                <label class="field"><span>Tagline</span><textarea class="input" rows="4" id="settingFooterTagline">${escape(footer.tagline)}</textarea></label>
                <label class="field"><span>Copyright</span><input class="input" id="settingCopyright" value="${attr(footer.copyright)}"></label>
            </div>
            <div class="panel">
                <h2>SEO &amp; social</h2>
                <label class="field"><span>SEO title</span><input class="input" id="settingSeoTitle" value="${attr(seo.title)}"></label>
                <label class="field"><span>SEO description</span><textarea class="input" rows="3" id="settingSeoDescription">${escape(seo.description)}</textarea></label>
                <label class="field"><span>Keywords</span><input class="input" id="settingSeoKeywords" value="${attr(seo.keywords)}"></label>
                <label class="field"><span>Social image</span><input class="input" id="settingSeoImage" value="${attr(seo.ogImage)}"></label>
            </div>
            <div class="panel">
                <h2>Homepage team</h2>
                <label class="field"><span>Student slugs, one per line</span><textarea class="input" rows="5" id="settingTeam">${escape((team.slugs || []).join('\n'))}</textarea></label>
            </div>
            <div class="panel">
                <h2>Student priority</h2>
                <label class="field"><span>Student slugs, one per line</span><textarea class="input" rows="5" id="settingPriority">${escape((priority.slugs || []).join('\n'))}</textarea></label>
            </div>
        `;
    }

    async function saveSettings() {
        const lines = (id) => $(`#${id}`).value.split(/\n/).map((value) => value.trim()).filter(Boolean);
        const payload = {
            site: {
                name: $('#settingSiteName').value.trim(),
                school: $('#settingSchool').value.trim(),
                system: $('#settingSystem').value.trim()
            },
            hero: {
                title: $('#settingHeroTitle').value.trim(),
                subtitle: $('#settingHeroSubtitle').value.trim(),
                readMore: $('#settingHeroButton').value.trim()
            },
            about: {
                text: $('#settingAboutText').value.trim(),
                cta: $('#settingAboutCta').value.trim()
            },
            school: { items: lines('settingSchoolItems') },
            social: {
                instagram: $('#settingInstagram').value.trim(),
                facebook: $('#settingFacebook').value.trim()
            },
            videos: {
                main: $('#settingVideoMain').value.trim(),
                secondary: $('#settingVideoSecondary').value.trim()
            },
            footer: {
                tagline: $('#settingFooterTagline').value.trim(),
                copyright: $('#settingCopyright').value.trim()
            },
            seo: {
                title: $('#settingSeoTitle').value.trim(),
                description: $('#settingSeoDescription').value.trim(),
                keywords: $('#settingSeoKeywords').value.trim(),
                ogImage: $('#settingSeoImage').value.trim()
            },
            team: { slugs: lines('settingTeam') },
            student_priority: { slugs: lines('settingPriority') }
        };

        const button = $('#saveSettingsButton');
        Utils.setBusy(button, true, 'Saving…');
        try {
            await DataStore.saveSettings(payload);
            renderSettings();
            Utils.toast('Settings saved.', 'success');
        } catch (error) {
            Utils.toast(error.message, 'error');
        } finally {
            Utils.setBusy(button, false);
        }
    }

    async function loadAudit() {
        const button = $('#refreshAuditButton');
        Utils.setBusy(button, true, 'Loading…');
        setListLoading($('#auditList'), 3);
        try {
            Admin.audit = await DataStore.getAuditLog(150);
            renderAudit();
        } catch (error) {
            $('#auditList').innerHTML = errorState(error.message);
        } finally {
            Utils.setBusy(button, false);
        }
    }

    function renderAudit() {
        if (!Admin.audit.length) {
            $('#auditList').innerHTML = emptyState('No audit entries yet.');
            return;
        }
        $('#auditList').innerHTML = Admin.audit.map((entry) => {
            const canRestore = entry.table_name === 'events'
                ? Boolean(DataStore.getEvent(entry.record_id)?.deleted_at)
                : entry.table_name === 'students'
                    ? Boolean(DataStore.getStudent(entry.record_id, { includeDeleted: true })?.deleted_at)
                    : false;
            const date = new Date(entry.created_at).toLocaleString('en-GB');
            return `
                <div class="audit-row">
                    <div class="audit-top">
                        <span><span class="audit-action">${escape(entry.action)}</span> ${escape(entry.table_name)} · ${escape(entry.summary || '')}</span>
                        <span>${escape(date)}</span>
                    </div>
                    <div class="muted" style="margin:4px 0 6px;">${escape(entry.actor_email || 'unknown editor')}</div>
                    <div class="btn-row">
                        ${canRestore ? `<button type="button" class="btn btn-secondary btn-small" data-action="restore-audit" data-table="${attr(entry.table_name)}" data-record="${attr(entry.record_id)}">Restore</button>` : ''}
                        <button type="button" class="btn btn-secondary btn-small" data-action="view-audit" data-index="${Admin.audit.indexOf(entry)}">View diff</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function handleAuditClick(event) {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        if (button.dataset.action === 'view-audit') {
            const entry = Admin.audit[Number(button.dataset.index)];
            openModal(`
                <h2>Audit diff</h2>
                <pre class="code-block">${escape(JSON.stringify(entry.diff, null, 2))}</pre>
                <div class="modal-actions"><button type="button" class="btn btn-secondary" data-close-modal>Close</button></div>
            `).querySelector('[data-close-modal]').addEventListener('click', closeModal);
            return;
        }
        if (button.dataset.action === 'restore-audit') {
            const record = button.dataset.record;
            try {
                if (button.dataset.table === 'events') await DataStore.restoreEvent(record);
                else await DataStore.restoreStudent(record);
                await loadAudit();
                renderEvents();
                renderStudents();
                Utils.toast('Item restored.', 'success');
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
        }
    }

    function renderExport() {
        const data = DataStore.exportData();
        $('#exportPreview').textContent = JSON.stringify(data, null, 2);
    }

    function downloadJson(filename, data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    function updateImagePreview(inputId, previewId) {
        const input = document.getElementById(inputId);
        const preview = document.getElementById(previewId);
        if (!input || !preview) return;
        const value = input.value.trim();
        preview.hidden = !value;
        if (value) preview.src = value;
    }

    async function compressImage(file) {
        if (!window.imageCompression) return file;
        return window.imageCompression(file, {
            maxSizeMB: 1.2,
            maxWidthOrHeight: 1800,
            useWebWorker: true,
            initialQuality: 0.85
        });
    }

    function pickAndUpload(targetId, folder, cropType, onUploaded) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const compressed = await compressImage(file);
                const aspect = cropType === 'square' ? 1 : cropType === 'wide' ? 16 / 9 : NaN;
                if (Number.isFinite(aspect) && window.Cropper) {
                    openCropModal(compressed, aspect, async (cropped) => {
                        await uploadAndApply(cropped, folder, targetId, onUploaded);
                    });
                } else {
                    await uploadAndApply(compressed, folder, targetId, onUploaded);
                }
            } catch (error) {
                Utils.toast(error.message, 'error');
            }
        });
        input.click();
    }

    async function uploadAndApply(file, folder, targetId, onUploaded) {
        Utils.toast('Uploading image…', 'info');
        try {
            const url = await DataStore.uploadImage(file, folder);
            if (typeof onUploaded === 'function') onUploaded(url);
            if (targetId) {
                const target = document.getElementById(targetId);
                if (target) {
                    target.value = url;
                    const previewMap = {
                        eventCoverImage: 'eventCoverPreview',
                        studentImage: 'studentImagePreview'
                    };
                    if (previewMap[targetId]) updateImagePreview(targetId, previewMap[targetId]);
                    if (targetId === 'eventCoverImage') renderEventPreview();
                }
            }
            Utils.toast('Image uploaded.', 'success');
        } catch (error) {
            Utils.toast(error.message, 'error');
        }
    }

    function openCropModal(file, aspect, onDone) {
        const url = URL.createObjectURL(file);
        const modal = openModal(`
            <h2>Crop image</h2>
            <div class="cropper-wrap"><img id="cropImage" src="${attr(url)}" alt=""></div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-crop-cancel>Cancel</button>
                <button type="button" class="btn btn-secondary" data-crop-skip>Use full image</button>
                <button type="button" class="btn btn-primary" data-crop-apply>Apply crop</button>
            </div>
        `, () => {
            URL.revokeObjectURL(url);
        });

        const image = modal.querySelector('#cropImage');
        Admin.activeCropper = new Cropper(image, {
            aspectRatio: aspect,
            viewMode: 1,
            autoCropArea: 1,
            background: false,
            responsive: true
        });

        const finish = (blob) => {
            closeModal();
            const name = file.name.replace(/\.[^.]+$/, '') || 'image';
            onDone(new File([blob], `${name}.jpg`, { type: 'image/jpeg' }));
        };

        modal.querySelector('[data-crop-cancel]').addEventListener('click', closeModal);
        modal.querySelector('[data-crop-skip]').addEventListener('click', () => {
            closeModal();
            onDone(file);
        });
        modal.querySelector('[data-crop-apply]').addEventListener('click', () => {
            const canvas = Admin.activeCropper.getCroppedCanvas({ maxWidth: 1800, maxHeight: 1800, imageSmoothingQuality: 'high' });
            canvas.toBlob((blob) => {
                if (blob) finish(blob);
            }, 'image/jpeg', 0.9);
        });
    }

    function openModal(content, cleanup) {
        closeModal();
        Admin.modalCleanup = typeof cleanup === 'function' ? cleanup : null;
        const root = $('#modalRoot');
        root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${content}</div></div>`;
        const backdrop = root.firstElementChild;
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) closeModal();
        });
        return backdrop.querySelector('.modal');
    }

    function closeModal() {
        if (Admin.activeCropper) {
            Admin.activeCropper.destroy();
            Admin.activeCropper = null;
        }
        const cleanup = Admin.modalCleanup;
        Admin.modalCleanup = null;
        $('#modalRoot').innerHTML = '';
        if (cleanup) cleanup();
    }

    function confirmDialog(title, message, confirmLabel = 'Delete') {
        return new Promise((resolve) => {
            const modal = openModal(`
                <h2>${escape(title)}</h2>
                <p>${escape(message)}</p>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-confirm-cancel>Cancel</button>
                    <button type="button" class="btn btn-danger" data-confirm-ok>${escape(confirmLabel)}</button>
                </div>
            `);
            modal.querySelector('[data-confirm-cancel]').addEventListener('click', () => {
                closeModal();
                resolve(false);
            });
            modal.querySelector('[data-confirm-ok]').addEventListener('click', () => {
                closeModal();
                resolve(true);
            });
        });
    }

    init();
})();
