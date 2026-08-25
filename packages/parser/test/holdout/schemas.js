'use strict';
const F = {
  invoice_number: { name:'invoice_number', type:'string', description:'the invoice, credit note or reference number of this document', hint:'labelled Invoice no., Rechnung Nr., Facture n°, 发票号码' },
  receipt_number: { name:'receipt_number', type:'string', description:'the receipt number' },
  order_number:   { name:'order_number',   type:'string', description:'the order number' },
  total:          { name:'total',          type:'number', description:'the grand total actually payable or actually charged, including tax; negative for a credit note' },
  subtotal:       { name:'subtotal',       type:'number', description:'net subtotal before tax' },
  tax:            { name:'tax',            type:'number', description:'tax / VAT / MwSt / TVA amount' },
  shipping:       { name:'shipping',       type:'number', description:'shipping or delivery cost' },
  discount:       { name:'discount',       type:'number', description:'discount amount as a positive number' },
  currency:       { name:'currency',       type:'string', description:'ISO 4217 code of the currency actually charged' },
  invoice_date:   { name:'invoice_date',   type:'date',   description:'the date the document was issued' },
  due_date:       { name:'due_date',       type:'date',   description:'the date payment is due' },
  payment_date:   { name:'payment_date',   type:'date',   description:'the date payment was taken' },
  delivery_date:  { name:'delivery_date',  type:'date',   description:'the estimated or actual delivery date, not the ship date' },
  vendor:         { name:'vendor',         type:'string', description:'the legal name of the company that issued the document' },
  carrier:        { name:'carrier',        type:'string', description:'the shipping carrier' },
  tracking_number:{ name:'tracking_number',type:'string', description:'the parcel tracking number' },
  card_last4:     { name:'card_last4',     type:'string', description:'last four digits of the card used' },
  attachment_filename: { name:'attachment_filename', type:'string', description:'the filename of the attached document' },
  line_items:     { name:'line_items', type:'array', description:'every line item row in the document, one object per row',
                    items:{ type:'object', fields:[
                      {name:'description',type:'string'},
                      {name:'quantity',type:'number'},
                      {name:'amount',type:'number'}]} },
};
function pick(...names){ return names.map(n=>{ const f=F[n]; if(!f) throw new Error('no field '+n); return f; }); }
module.exports = { F, pick };
