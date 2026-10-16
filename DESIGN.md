Build a multi-tenant inventory system with access-control (using roles)

inventory support mutiple pharmacies (tenant)

CRUD (APIS) product and purchase orders

tenant isolation - can not access outside their inventory

front-end to test this 
    - different tenant with login/pw


Inventory Management System with User Access defined by roles (User, Admin)
Each tenant will have its own isolated inventory

A catalog will be defined as an external source/system. 
Customer can view the catalog and define the inventory quanity in their system.

Inventory system will allow customers to add to cart. 


Admin (Pharmisist / manager / admin) -> Catalog -> add item (quanity) to inventory
                 -> remove items from inventory

User (Pharmisist) -> Inventory
                         -> purchase inventory based on quanity
                                -> avoid double checkouts

Schemas

Tenant (CVS / Walgreens / etc )
    id

User
    - id
    - email
    - tenantId
    - roleId

Roll
    - id
    - type (user, admin) 

Inventory
    id
    tenantId
    updatedManager (who added to inventory) (FK: userId)
    count

(Skip Row Locked Pattern)
Item table to inventory
    - item


Orders
    - id
    - status (PENDING, DELIVERED)
    - itemID


APIs:

GET /catalogs -> Catalog[]

GET /inventories/{inventoryID} -> Inventory

POST /inventories -> id-empotent {
    item: catalog.item,
    id: catalogId -> inventoryId,
    quantity: 50
}

PATCH /inventories{inventoryID} -> (Placing an order)

Client -> Catalog Service -> Catalog DB
        -> Inventory Service -> Inventory DB
            -> GET, POST, PATCH  
