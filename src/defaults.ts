// Default `_fields` for list endpoints whose full rows are wide. Applied when the caller gives no
// `_fields` and no `full=true`. Every name must exist in the catalog (test/defaults.test.ts) and be
// listed in spec/used.json so the weekly spec diff flags AroFlo removing it.
export const DEFAULT_FIELDS: Record<string, string> = {
  'GET /tasks': 'id,jobNumber,name,status,substatus,taskType,client,location,dueDate,requestedDateTime',
  'GET /invoices': 'id,invoiceNumber,status,client,invoicedDateTime,dueDate,totalAmountInc,balanceDue',
  'GET /users': 'id,givenName,familyName,position,email,mobile',
  'GET /timesheets/entries': 'id,date,hours,user,workType,trackingCentre,note',
  'GET /tasks/{taskId}/labours': 'id,date,hours,user,workType,note',
  'GET /locations': 'id,address1,suburb,postCode,siteContact,archived',
  'GET /projects': 'id,projectNumber,name,client,status,startDate,endDate,manager',
  'GET /purchaseorders': 'id,orderNumber,jobNumber,supplierName,status,purchaseDate,totalAmountInc',
  'GET /businessunits/{businessUnitId}/inventoryitems': 'id,partNo,description,uom,costPrice,sellEx'
};

/** Fields the job and quote tools ask for. Also listed in spec/used.json. */
export const JOB_FIELDS = 'id,jobNumber,name,status,substatus,taskType,client,location,locationText,dueDate,requestedDateTime,priority,project,description,resources,schedule';
export const JOB_LABOUR_FIELDS = 'date,hours,user,workType';
export const JOB_MATERIAL_FIELDS = 'itemName,partNumber,quantity,unitType,sell';
export const QUOTE_LINE_FIELDS = 'item,partNumber,type,quantity,uom,unitSell,lineTotal,labourQuantity,isOptional,isAssembly,parentId';
export const QUOTE_HEADER_FIELDS = 'id,jobNumber,name,status,substatus,acceptanceStatus,client,estimatedByUser,dueDate,requested,locationText,taskType,description,counts';

/**
 * Operations, response fields and query params ("param:x") the composite tools and lookups depend on.
 * Merged with DEFAULT_FIELDS into spec/used.json (npm run spec:used) so the weekly spec diff flags
 * AroFlo removing any of them; test/spec-contract.test.ts keeps the file in sync.
 */
export const COMPOSITE_USES: Record<string, string[]> = {
  'GET /businessunits': ['id', 'param:_fields', 'param:limit'],
  // archived: the filter the GET /clients hint names.
  'GET /clients': ['param:archived'],
  // serviceId: the task-type filter named in the aroflo_get description and a hint.
  'GET /tasks': ['id', 'jobNumber', 'name', 'param:sortBy', 'param:ascending', 'param:_fields', 'param:page', 'param:limit', 'param:serviceId'],
  'GET /timesheets/entries': ['param:endDate', 'param:taskId'],
  'GET /quotes': ['id', 'jobNumber', 'name', 'param:_fields', 'param:page', 'param:limit'],
  'GET /tasks/{taskId}': [...JOB_FIELDS.split(','), 'param:_fields'],
  'GET /tasks/{taskId}/labours': [...JOB_LABOUR_FIELDS.split(','), 'param:_fields', 'param:page', 'param:limit'],
  'GET /tasks/{taskId}/materials': [...JOB_MATERIAL_FIELDS.split(','), 'param:businessUnitId', 'param:_fields'],
  'GET /tasks/{task_id}/notes': ['note', 'timestampCreated', 'param:_fields'],
  'GET /quotes/{quoteId}': [...QUOTE_HEADER_FIELDS.split(','), 'param:_fields'],
  'GET /quotes/{quoteId}/takeoffs': ['id', 'name', 'breakdown', 'param:page', 'param:limit'],
  'GET /quotes/{quoteId}/lineitems': [...QUOTE_LINE_FIELDS.split(','), 'param:takeoffId', 'param:_fields', 'param:page', 'param:limit']
};

/** The spec/used.json content: every operation this server depends on, with sorted entries. */
export function usedOps(): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const add = (k: string, entries: string[]) => entries.forEach((e) => (out[k] ??= new Set()).add(e));
  for (const [k, fields] of Object.entries(DEFAULT_FIELDS)) add(k, fields.split(','));
  for (const [k, entries] of Object.entries(COMPOSITE_USES)) add(k, entries);
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map((k) => [k, [...out[k]!].sort()])
  );
}

/**
 * Facts about AroFlo behaviour the spec doesn't state, learned from live calls. All are shown in aroflo_api
 * details. One is appended to an aroflo_get result when the call uses `param`, or leaves out `absent`.
 */
export const HINTS: Record<string, Array<{ param?: string; absent?: string; text: string }>> = {
  // test/spec-contract.test.ts fails when AroFlo adds a created date or status to clients, so these stay true.
  'GET /clients': [
    { absent: 'archived', text: 'This list includes archived clients, and rows carry no status. archived=false lists active clients only, archived=true archived only.' },
    { text: "Clients have no created date in API v2: no field in lists or records, and no date filter. Say so; don't infer one from notes, jobs or ids." }
  ],
  'GET /tasks': [
    { param: 'requiredByTo', text: 'requiredByTo=D stops at D 00:00, so jobs due later on D are left out; to cover all of day D use requiredByTo=D+1 and drop rows due D+1.' },
    { text: 'serviceId=<id from /types/tasks> filters by task type. serviceList answered 500 in testing.' }
  ],
  'GET /schedules': [{ param: 'scheduleZone', text: 'scheduleZone=USER lists the token user\'s own calendar for currentDate; a job\'s schedule is in aroflo_job.' }],
  'GET /timesheets/entries': [
    { absent: 'endDate', text: 'Without endDate you get one day only: endDate defaults to entryDate.' },
    { text: 'Rows carry no task. For one job add taskId=<task id, not the job number>.' }
  ]
};
